-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "errorParams" JSONB;
