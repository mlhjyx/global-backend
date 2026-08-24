import { PrismaService } from '../src/prisma/prisma.service';

const expected = process.env.EXPECT_APP_DATABASE_READINESS ?? 'ready';
if (!['ready', 'DATABASE_PRINCIPAL_INVALID'].includes(expected)) {
  throw new Error('EXPECT_APP_DATABASE_READINESS is invalid');
}

const prisma = new PrismaService();
try {
  const result = await prisma.reconnect();
  const actual = result.status === 'ready' ? 'ready' : result.code;
  if (actual !== expected) {
    throw new Error(
      `app database principal readiness mismatch: expected ${expected}, got ${actual}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ status: 'APP_DATABASE_PRINCIPAL_VERIFIED', readiness: actual })}\n`,
  );
} finally {
  await prisma.onModuleDestroy();
}
