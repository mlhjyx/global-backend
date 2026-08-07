export const DEPLOYMENT_STAGES = Object.freeze(['development', 'pilot', 'production'] as const);

export type DeploymentStage = (typeof DEPLOYMENT_STAGES)[number];

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Resolves the deployment stage from server-owned process configuration.
 * NODE_ENV=production is a one-way safety floor and cannot be downgraded.
 */
export function resolveDeploymentStage(env: Environment): DeploymentStage {
  const configured = env.DEPLOYMENT_STAGE;
  if (configured !== undefined && !DEPLOYMENT_STAGES.includes(configured as DeploymentStage)) {
    throw new Error(`DEPLOYMENT_STAGE must be one of ${DEPLOYMENT_STAGES.join(', ')}`);
  }

  if (env.NODE_ENV === 'production' && configured === 'development') {
    throw new Error('DEPLOYMENT_STAGE development cannot downgrade NODE_ENV=production');
  }

  if (configured) return configured as DeploymentStage;
  return env.NODE_ENV === 'production' ? 'production' : 'development';
}
