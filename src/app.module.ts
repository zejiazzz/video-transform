import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { OrderModule } from './order/order.module';
import { PrismaModule } from './prisma/prisma.module';
import { PostService } from './post/post.service';
import { PostModule } from './post/post.module';
import { UserModule } from './user/user.module';
import { ModelsModule } from './models/models.module';
import { PromptsService } from './prompts/prompts.service';
import { PromptsModule } from './prompts/prompts.module';
import { ChainsModule } from './chains/chains.module';
import { AgentsModule } from './agents/agents.module';
import { ChainsService } from './chains/chains.service';
import { AgentsService } from './agents/agents.service';

@Module({
  imports: [
    UserModule,
    OrderModule,
    PrismaModule,
    PostModule,
    ModelsModule,
    PromptsModule,
    ChainsModule,
    AgentsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    PostService,
    PromptsService,
    ChainsService,
    AgentsService,
  ],
})
export class AppModule {}
