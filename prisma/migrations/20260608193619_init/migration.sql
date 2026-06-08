-- CreateTable
CREATE TABLE "BasePrice" (
    "id" SERIAL NOT NULL,
    "category" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "reference" TEXT,
    "condition" TEXT NOT NULL,
    "dateFrom" DATE,
    "dateTo" DATE,
    "price" DECIMAL(10,2) NOT NULL,
    "dingRuleKey" TEXT,
    "sourceSheet" TEXT NOT NULL,
    "sourceRow" INTEGER NOT NULL,

    CONSTRAINT "BasePrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdjustmentRule" (
    "id" SERIAL NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "deltaAmount" DECIMAL(10,2) NOT NULL,
    "note" TEXT,
    "sourceSheet" TEXT NOT NULL,

    CONSTRAINT "AdjustmentRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BasePrice_category_productName_reference_condition_idx" ON "BasePrice"("category", "productName", "reference", "condition");

-- CreateIndex
CREATE UNIQUE INDEX "AdjustmentRule_scopeKey_key" ON "AdjustmentRule"("scopeKey");

-- AddForeignKey
ALTER TABLE "BasePrice" ADD CONSTRAINT "BasePrice_dingRuleKey_fkey" FOREIGN KEY ("dingRuleKey") REFERENCES "AdjustmentRule"("scopeKey") ON DELETE SET NULL ON UPDATE CASCADE;
