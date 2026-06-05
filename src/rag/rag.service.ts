// src/rag/rag.service.ts

import { Injectable } from '@nestjs/common';
import { ChatOllama, OllamaEmbeddings } from '@langchain/ollama';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { Document } from '@langchain/core/documents';
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory';
import { config } from '../config';

function getMetadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' ? value : undefined;
}

@Injectable()
export class RagService {
  // 对话模型：RAG 场景用低温度，让回答更严格
  private llm = new ChatOllama({
    model: config.ollama.chatModel,
    baseUrl: config.ollama.baseUrl,
    temperature: 0.1,
  });

  // 向量化模型：把文本转成数字向量（用于相似度比较）
  private embeddings = new OllamaEmbeddings({
    model: config.ollama.embedModel, // 'mxbai-embed-large'
    baseUrl: config.ollama.baseUrl,
  });

  // 内存向量库（null 表示未初始化）
  private vectorStore: MemoryVectorStore | null = null;
  private docCount = 0;

  // ── 加载文档到向量库 ───────────────────────────────────
  async loadDocuments(
    documents: { id: string; content: string; source?: string }[],
  ) {
    // 文本分块器
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

    // fromDocuments：批量向量化所有文档块，存入内存向量库
    // 内部调用 this.embeddings.embedDocuments(texts) 转成向量
    this.vectorStore = await MemoryVectorStore.fromDocuments(
      allDocs,
      this.embeddings,
    );
    this.docCount = documents.length;

    return {
      success: true,
      originalDocs: documents.length,
      totalChunks: allDocs.length,
      message: `加载 ${documents.length} 篇文档，共 ${allDocs.length} 个块`,
    };
  }

  // ── 纯向量检索（不过大模型，直接看检索结果）──────────
  async search(query: string, topK = 3) {
    if (!this.vectorStore) return { error: '请先调用 /rag/load 加载文档' };

    // similaritySearchWithScore 内部流程：
    // 1. 把 query 向量化（调用 embeddings.embedQuery）
    // 2. 和向量库里所有文档向量计算余弦相似度
    // 3. 按相似度排序，返回前 topK 个
    const results = await this.vectorStore.similaritySearchWithScore(
      query,
      topK,
    );

    return {
      query,
      results: results.map(([doc, score]) => ({
        content: doc.pageContent,
        source: getMetadataString(doc.metadata, 'source'),
        score: parseFloat(score.toFixed(4)), // 越高越相关（0~1）
      })),
    };
  }

  // ── 完整 RAG 问答 ─────────────────────────────────────
  async query(question: string, topK = 3) {
    if (!this.vectorStore) return { error: '请先调用 /rag/load 加载文档' };

    // Step 1：检索相关文档块
    const retrieved = await this.vectorStore.similaritySearchWithScore(
      question,
      topK,
    );

    if (!retrieved.length) {
      return { question, answer: '知识库中没有找到相关内容', sources: [] };
    }

    // Step 2：把检索结果拼成 context 字符串
    // [1] 第一块内容\n\n[2] 第二块内容...
    // 编号方便模型在回答时引用："根据[1]..."
    const context = retrieved
      .map(([doc], i) => `[${i + 1}] ${doc.pageContent}`)
      .join('\n\n');

    // Step 3：RAG Prompt，严格限制模型只能用参考资料回答
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

    // Step 4：调用模型生成回答
    const chain = prompt.pipe(this.llm).pipe(new StringOutputParser());
    const answer = await chain.invoke({ context, question });

    return {
      question,
      answer,
      sources: retrieved.map(([doc, score]) => ({
        content: doc.pageContent,
        source: getMetadataString(doc.metadata, 'source'),
        score: parseFloat(score.toFixed(4)),
      })),
    };
  }

  getStatus() {
    return {
      loaded: !!this.vectorStore,
      docCount: this.docCount,
      message: this.vectorStore
        ? `已加载 ${this.docCount} 篇文档`
        : '知识库为空，请先加载文档',
    };
  }

  clearKnowledge() {
    this.vectorStore = null;
    this.docCount = 0;
    return { success: true, message: '知识库已清空' };
  }
}
