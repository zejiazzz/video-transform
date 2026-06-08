// src/rag/rag.service.ts（PGVector 版本，完整修复）

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOllama, OllamaEmbeddings } from '@langchain/ollama';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { Document } from '@langchain/core/documents';
import {
  PGVectorStore,
  DistanceStrategy,
} from '@langchain/community/vectorstores/pgvector';
import { Pool } from 'pg';
import { config } from '../config';

export interface RagSearchResult {
  content: string;
  source: string;
  similarity: number;
  rawDistance?: number;
}

export interface RagSearchResponse {
  query: string;
  results: RagSearchResult[];
}

function getMetadataString(
  metadata: Record<string, unknown>,
  key: string,
): string {
  const value = metadata[key];
  return typeof value === 'string' ? value : '';
}

@Injectable()
export class RagService implements OnModuleDestroy {
  private readonly pool: Pool;
  private readonly pgVectorConfig: {
    pool: Pool;
    collectionName: string;
    collectionTableName: string;
    tableName: string;
    columns: {
      idColumnName: string;
      vectorColumnName: string;
      contentColumnName: string;
      metadataColumnName: string;
    };
    distanceStrategy: DistanceStrategy;
  };

  private llm = new ChatOllama({
    model: config.ollama.chatModel,
    baseUrl: config.ollama.baseUrl,
    temperature: 0.1,
    think: false,
    numPredict: 1024,
  });

  private embeddings = new OllamaEmbeddings({
    model: config.ollama.embedModel,
    baseUrl: config.ollama.baseUrl,
  });

  private docCount = 0;

  constructor(private readonly configService: ConfigService) {
    const databaseUrl = this.configService.get<string>('DATABASE_URL');
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is not configured');
    }

    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    this.pgVectorConfig = {
      pool: this.pool,
      collectionName: 'rag-knowledge-base',
      collectionTableName: 'langchain_pg_collection',
      tableName: 'langchain_pg_embedding',
      columns: {
        idColumnName: 'id',
        vectorColumnName: 'embedding',
        contentColumnName: 'document',
        metadataColumnName: 'cmetadata',
      },
      distanceStrategy: 'cosine',
    };
  }

  // ── 加载文档 ────────────────────────────────────────
  async loadDocuments(
    documents: { id: string; content: string; source?: string }[],
  ) {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 500,
      chunkOverlap: 50,
      separators: ['\n\n', '\n', '。', '！', '？', ' ', ''],
    });

    const allDocs: Document[] = [];
    for (const doc of documents) {
      const chunks = await splitter.createDocuments(
        [doc.content],
        [{ source: doc.source || doc.id, docId: doc.id }],
      );
      allDocs.push(...chunks);
    }

    // fromDocuments 内部会从 this.pool 取连接，用完自动归还
    // 不需要手动 end()
    await PGVectorStore.fromDocuments(
      allDocs,
      this.embeddings,
      this.pgVectorConfig,
    );

    this.docCount += documents.length;
    return {
      success: true,
      originalDocs: documents.length,
      totalChunks: allDocs.length,
      message: `已存入 ${documents.length} 篇文档（${allDocs.length} 个块）到 PostgreSQL`,
    };
  }

  // ── 纯向量检索 ────────────────────────────────────
  async search(query: string, topK = 3): Promise<RagSearchResponse> {
    // initialize() 从 this.pool 借一个连接，查完自动归还
    // ✅ 不需要也不应该调用 end()
    const vectorStore = await PGVectorStore.initialize(
      this.embeddings,
      this.pgVectorConfig,
    );

    const results = await vectorStore.similaritySearchWithScore(query, topK);
    // ❌ 删掉这行：await vectorStore.end()

    return {
      query,
      results: results.map(
        ([doc, score]): RagSearchResult => ({
          content: doc.pageContent,
          source: getMetadataString(doc.metadata, 'source'),
          // score 是余弦距离（越小越相关），转成相似度更直观
          similarity: parseFloat((1 - score).toFixed(4)),
          rawDistance: parseFloat(score.toFixed(4)),
        }),
      ),
    };
  }

  // ── 完整 RAG 问答 ─────────────────────────────────
  async query(question: string, topK = 3) {
    const vectorStore = await PGVectorStore.initialize(
      this.embeddings,
      this.pgVectorConfig,
    );
    // ❌ 同样不要 end()

    const retrieved = await vectorStore.similaritySearchWithScore(
      question,
      topK,
    );

    // score 是距离，越小越相关
    // 过滤掉距离 > 0.5 的结果（相似度 < 0.5，基本不相关）
    const filtered = retrieved.filter(([, score]) => score <= 0.5);

    if (!filtered.length) {
      return { question, answer: '知识库中没有找到相关内容', sources: [] };
    }

    const context = filtered
      .map(([doc], i) => `[${i + 1}] ${doc.pageContent}`)
      .join('\n\n');

    const prompt = ChatPromptTemplate.fromMessages([
      [
        'system',
        `你是知识库问答助手，严格基于参考资料回答。
规则：
1. 只根据参考资料内容回答，不能使用资料外的知识
2. 资料中没有相关信息，回答"知识库中暂无相关内容"
3. 回答简洁准确，使用中文

参考资料：
{context}`,
      ],
      ['human', '{question}'],
    ]);

    const chain = prompt.pipe(this.llm).pipe(new StringOutputParser());
    const answer = await chain.invoke({ context, question });

    return {
      question,
      answer,
      sources: filtered.map(([doc, score]) => ({
        content: doc.pageContent,
        source: getMetadataString(doc.metadata, 'source'),
        similarity: parseFloat((1 - score).toFixed(4)),
      })),
    };
  }

  async getStatus() {
    try {
      const result = await this.pool.query(
        `SELECT COUNT(*) FROM langchain_pg_embedding
         WHERE collection_id = (
           SELECT uuid FROM langchain_pg_collection WHERE name = $1
         )`,
        [this.pgVectorConfig.collectionName],
      );
      const countRow = result.rows[0] as { count: string } | undefined;
      const chunkCount = parseInt(countRow?.count ?? '0', 10);
      return {
        mode: 'PGVectorStore',
        loaded: chunkCount > 0,
        chunkCount,
        collection: this.pgVectorConfig.collectionName,
        message:
          chunkCount > 0
            ? `PostgreSQL 向量库中有 ${chunkCount} 个文档块`
            : '向量库为空，请先加载文档',
      };
    } catch {
      return {
        mode: 'PGVectorStore',
        loaded: false,
        message: '向量表未初始化',
      };
    }
  }

  async clearKnowledge() {
    await this.pool.query(
      `DELETE FROM langchain_pg_embedding
       WHERE collection_id = (
         SELECT uuid FROM langchain_pg_collection WHERE name = $1
       )`,
      [this.pgVectorConfig.collectionName],
    );
    await this.pool.query(
      `DELETE FROM langchain_pg_collection WHERE name = $1`,
      [this.pgVectorConfig.collectionName],
    );
    this.docCount = 0;
    return {
      success: true,
      message: `已清空 collection：${this.pgVectorConfig.collectionName}`,
    };
  }

  // ✅ NestJS 应用退出时才真正关闭连接池
  async onModuleDestroy() {
    await this.pool.end();
    console.log('RagService：PostgreSQL 连接池已关闭');
  }
}
