import { Injectable } from '@nestjs/common';

@Injectable()
export class UserService {
  getUserInfo(): string {
    return '用户信息';
  }
  getUser(): string {
    return '用户信息';
  }
}
