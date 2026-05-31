import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { OrderModule } from './order/order.module';
import { PrismaModule } from './prisma/prisma.module';
import { PostService } from './post/post.service';
import { PostModule } from './post/post.module';
import { UserModule } from './user/user.module';

@Module({
  imports: [UserModule, OrderModule, PrismaModule, PostModule],
  controllers: [AppController],
  providers: [AppService, PostService],
})
export class AppModule {}
