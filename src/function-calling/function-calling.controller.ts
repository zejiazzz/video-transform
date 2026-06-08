import { Body, Controller, Post } from '@nestjs/common';
import {
  FunctionCallingService,
  type FunctionCallingResult,
} from './function-calling.service';

@Controller('function-calling')
export class FunctionCallingController {
  constructor(private readonly fcService: FunctionCallingService) {}

  @Post('run')
  run(@Body() body: { message: string }): Promise<FunctionCallingResult> {
    return this.fcService.runFunctionCalling(body.message);
  }
}
