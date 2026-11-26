import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspacePurgeInternalController } from './workspace-purge-internal.controller';
import { WorkspacePurgeService } from './workspace-purge.service';
import { WorkspacePurgeServiceTokenGuard } from './workspace-purge-service-token.guard';
import { WorkspaceService } from './workspace.service';

@Module({
  controllers: [WorkspaceController, WorkspacePurgeInternalController],
  providers: [WorkspaceService, WorkspacePurgeService, WorkspacePurgeServiceTokenGuard],
})
export class WorkspaceModule {}
