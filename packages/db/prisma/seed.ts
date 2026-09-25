import { prisma } from "../src/index.js";

// DATABASE_URL comes from the repo-root .env, loaded by `--env-file` in the
// `seed` script (and by prisma7.config.ts when run via `prisma db seed`).
try {
  await prisma.user.upsert({
    where: { githubId: 0 },
    update: {},
    create: { githubId: 0, login: "dev", avatarUrl: null },
  });
  console.log("seeded dev user");
} catch (error) {
  // Prisma puts only the code frame in `message`; the reason a connection
  // failed (e.g. ECONNREFUSED) is in `code`, so surface both.
  const code = (error as { code?: string })?.code;
  console.error(
    `Seed failed${code ? ` [${code}]` : ""}:`,
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  // The PrismaPg adapter holds an open pool; without this the process hangs.
  await prisma.$disconnect();
}
