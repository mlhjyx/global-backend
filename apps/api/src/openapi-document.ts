import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** code-first OpenAPI document (the repository's single REST contract source). */
export function buildOpenApi(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Global API')
    .setDescription('出海企业 AI 全球客户开发与增长平台 · 后端 API（前端接入见 packages/contracts/INTEGRATION.md）')
    .setVersion('0.1.0')
    .addServer('/', '同源部署（相对路径；具体 host 由部署环境决定）')
    .addTag('Companies')
    .addTag('Claims')
    .addTag('ICP')
    .addTag('Discovery')
    .addTag('Leads')
    .addTag('Events')
    .addTag('System')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  const buildStatus = document.components?.schemas?.BuildStatusResponseDto;
  if (buildStatus && !('$ref' in buildStatus)) {
    // ApiProperty uses `required` both for the parent property flag and the
    // nested object's required field list. Keep the closed nested schema and
    // restore the pre-existing required+nullable response key explicitly.
    buildStatus.required = Array.from(new Set([...(buildStatus.required ?? []), 'costSummary']));
  }
  return document;
}
