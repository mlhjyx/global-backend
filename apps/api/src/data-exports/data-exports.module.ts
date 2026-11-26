import { Module } from '@nestjs/common';
import { DataExportsController } from './data-exports.controller';
import { DataExportsService } from './data-exports.service';
import { DataExportStorage } from './data-exports.storage';

@Module({
  controllers: [DataExportsController],
  providers: [DataExportsService, DataExportStorage],
})
export class DataExportsModule {}
