import { Redis } from "@upstash/redis";
import { normalizeDomain } from "./domain.js";

const redis = Redis.fromEnv();
const KEY = "domain-investor:portfolio";
const MAX_DOMAINS = 99;

export async function getPortfolio() {
  return (await redis.get(KEY)) || [];
}

export async function addPortfolioDomain(input) {
  const domain = normalizeDomain(input.domain);
  if (!domain) return { error: "أدخل دوميناً صحيحاً مثل example.com." };

  for (const field of ["buyPrice", "renewalCost", "targetPrice"]) {
    const value = input[field];
    if (value != null && value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
      return { error: `قيمة ${field} يجب أن تكون رقماً موجباً أو صفراً.` };
    }
  }

  const items = await getPortfolio();
  if (items.some(x => x.domain === domain)) return { error: "هذا الدومين موجود بالفعل." };
  if (items.length >= MAX_DOMAINS) return { error: "وصلت إلى الحد الأقصى: 99 دوميناً." };

  const item = {
    domain,
    buyPrice: input.buyPrice ?? null,
    buyDate: input.buyDate || null,
    registrar: input.registrar || null,
    renewalDate: input.renewalDate || null,
    renewalCost: input.renewalCost ?? null,
    targetPrice: input.targetPrice ?? null,
    status: "holding",
    saleChannel: null,
    salePrice: null,
    soldDate: null,
    addedAt: new Date().toISOString()
  };
  items.push(item);
  await redis.set(KEY, items);
  return { item, count: items.length };
}

export async function updatePortfolioDomain(domainInput, field, value) {
  const domain = normalizeDomain(domainInput);
  const allowed = [
    "buyPrice", "buyDate", "registrar", "renewalDate", "renewalCost",
    "targetPrice", "status", "saleChannel", "salePrice", "soldDate"
  ];
  if (!domain || !allowed.includes(field)) return { error: "الدومين أو اسم الحقل غير صحيح." };

  const items = await getPortfolio();
  const item = items.find(x => x.domain === domain);
  if (!item) return { error: "الدومين غير موجود في المحفظة." };

  if (["buyPrice", "renewalCost", "targetPrice", "salePrice"].includes(field)) {
    if (value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
      return { error: "أدخل مبلغاً رقمياً موجباً أو صفراً." };
    }
    item[field] = value === "" ? null : Number(value);
  } else if (["buyDate", "renewalDate", "soldDate"].includes(field)) {
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return { error: "استخدم صيغة التاريخ YYYY-MM-DD." };
    }
    item[field] = value || null;
  } else if (field === "status") {
    if (!["holding", "listed", "sold", "dropped"].includes(value)) {
      return { error: "الحالة: holding أو listed أو sold أو dropped." };
    }
    item[field] = value;
  } else {
    item[field] = value || null;
  }

  item.updatedAt = new Date().toISOString();
  await redis.set(KEY, items);
  return { item };
}

export async function removePortfolioDomain(domainInput) {
  const domain = normalizeDomain(domainInput);
  const items = await getPortfolio();
  const next = items.filter(x => x.domain !== domain);
  if (next.length === items.length) return { error: "الدومين غير موجود في المحفظة." };
  await redis.set(KEY, next);
  return { count: next.length };
}
