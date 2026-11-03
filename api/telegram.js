import { normalizeDomain } from "../lib/domain.js";
import { getUsage, lookupDomain } from "../lib/whois.js";
import { getPortfolio, addPortfolioDomain, updatePortfolioDomain, removePortfolioDomain } from "../lib/portfolio.js";

const html = (value = "") => String(value).replace(/[&<>"]/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
}[c]));

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Telegram API error: ${response.status}`);
  return response.json();
}

async function reply(chatId, text, reply_markup) {
  return telegram("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) });
}
function domainKeyboard(domain) {
  return { inline_keyboard: [
    [{ text: "🔎 WHOIS", callback_data: `whois:${domain}` }, { text: "➕ إضافة للمحفظة", callback_data: `add:${domain}` }],
    [{ text: "📂 محفظتي", callback_data: "portfolio" }, { text: "📊 الاستهلاك", callback_data: "usage" }],
    [{ text: "❓ المساعدة", callback_data: "help" }]
  ] };
}
async function answerCallback(id, text) {
  return telegram("answerCallbackQuery", { callback_query_id: id, text });
}

function eventDate(data, action) {
  const event = (data.events || []).find(e => String(e.event_action || "").toLowerCase() === action);
  return event?.event_date || "";
}
function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function ageLabel(registration) {
  const date = parseDate(registration);
  if (!date) return "غير متاح";
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
  if (days < 30) return `جديد — منذ ${days} يوم`;
  if (days >= 365) return `قديم — منذ ${Math.floor(days / 365)} سنة`;
  return `عمره ${Math.floor(days / 30)} شهر`;
}
function expiryLabel(expiration) {
  const date = parseDate(expiration);
  if (!date) return { text: "غير متاح", days: null };
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const expiry = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const days = Math.ceil((expiry - today) / 86400000);
  if (days < 0) return { text: `منتهي منذ ${Math.abs(days)} يوم`, days };
  if (days === 0) return { text: "ينتهي اليوم", days };
  if (days <= 30) return { text: `قريب الانتهاء — متبقي ${days} يومًا`, days };
  return { text: `متبقي ${days} يومًا`, days };
}
function classification(registration, expiration) {
  const registered = parseDate(registration);
  const expiry = expiryLabel(expiration);
  if (expiry.days !== null && expiry.days < 0) return "منتهي";
  if (expiry.days !== null && expiry.days <= 30) return "قريب الانتهاء";
  if (registered) {
    const days = Math.floor((Date.now() - registered.getTime()) / 86400000);
    if (days < 30) return "دومين جديد";
    if (days >= 365) return "دومين قديم";
  }
  return "عمر متوسط أو بيانات غير مكتملة";
}
async function resolveIps(domain) {
  async function query(type, recordType) {
    try {
      const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`;
      const response = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(4000) });
      if (!response.ok) return [];
      const body = await response.json();
      return (body.Answer || []).filter(a => a.type === recordType).map(a => a.data).filter(Boolean);
    } catch { return []; }
  }
  const [a, aaaa] = await Promise.all([query("A", 1), query("AAAA", 28)]);
  return { ipv4: [...new Set(a)], ipv6: [...new Set(aaaa)] };
}


function money(value) {
  return value == null ? "—" : `$${Number(value).toFixed(2)}`;
}
function portfolioText(items) {
  if (!items.length) return "📁 محفظتك فارغة حالياً. أضف دوميناً باستخدام /add.";
  const rows = items.map((x, i) => [
    `${i + 1}. <b>${html(x.domain)}</b>`,
    `شراء: ${money(x.buyPrice)} | التجديد: ${money(x.renewalCost)}`,
    `موعد التجديد: ${html(x.renewalDate || "—")} | الهدف: ${money(x.targetPrice)}`,
    `الحالة: ${html(x.status)} | قناة البيع: ${html(x.saleChannel || "—")}`,
    x.status === "sold" ? `سعر البيع: ${money(x.salePrice)} | تاريخ البيع: ${html(x.soldDate || "—")}` : ""
  ].filter(Boolean).join("\n"));
  return `📁 <b>محفظة الدومينات (${items.length}/99)</b>\n\n${rows.join("\n\n")}`;
}
function portfolioHelp() {
  return [
    "📂 <b>أوامر إدارة المحفظة — USD</b>", "",
    "<code>/add domain.com | buyPrice | buyDate | registrar | renewalDate | renewalCost | targetPrice</code>",
    "<code>/add example.com | 12 | 2026-10-01 | Namecheap | 2027-10-01 | 14 | 500</code>", "",
    "<code>/portfolio</code> — عرض المحفظة",
    "<code>/edit domain.com | field | value</code> — تعديل",
    "<code>/remove domain.com</code> — حذف",
    "الحقول: buyPrice, buyDate, registrar, renewalDate, renewalCost, targetPrice, status, saleChannel, salePrice, soldDate",
    "الحالات: holding, listed, sold, dropped. قنوات البيع: marketplace أو private.",
    "التواريخ YYYY-MM-DD والمبالغ بالدولار."
  ].join("\n");
}
function optionalMoney(value, label) {
  if (value == null || value === "") return { value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return { error: `قيمة ${label} يجب أن تكون رقماً موجباً أو صفراً.` };
  return { value: n };
}

async function formatWhois(domain, data, source) {
  const nameservers = (data.nameservers || []).map(n => n.ldh_name || n.name || "").filter(Boolean);
  const statuses = (data.statuses || []).join(", ") || "غير متاح";
  const contacts = data.contacts?.registrant || {};
  const registrant = [contacts.organization, contacts.name, contacts.country, contacts.email].filter(Boolean).join(" · ") || "غير متاح / محجوب";
  const registration = eventDate(data, "registration");
  const expiration = eventDate(data, "expiration");
  const updated = eventDate(data, "last changed") || data.updated_date || "غير متاح";
  const expiry = expiryLabel(expiration);
  const ips = await resolveIps(domain);
  return [
    `🔎 <b>WHOIS: ${html(domain)}</b>`, "",
    `🏢 <b>Registrar:</b> ${html(data.registrar || "غير متاح")}`,
    `📅 <b>Registration:</b> ${html(registration || "غير متاح")}`,
    `🎂 <b>Domain age:</b> ${html(ageLabel(registration))}`,
    `⌛ <b>Expiration:</b> ${html(expiration || "غير متاح")}`,
    `⏳ <b>Time remaining:</b> ${html(expiry.text)}`,
    `🏷️ <b>Classification:</b> ${html(classification(registration, expiration))}`,
    `🔄 <b>Updated:</b> ${html(updated)}`,
    `📌 <b>Status:</b> ${html(statuses)}`,
    `🌐 <b>Name servers:</b> ${html(nameservers.join(", ") || "غير متاح")}`,
    `🖥️ <b>IPv4:</b> ${html(ips.ipv4.join(", ") || "غير متاح")}`,
    `🖥️ <b>IPv6:</b> ${html(ips.ipv6.join(", ") || "غير متاح")}`,
    `👤 <b>Registrant:</b> ${html(registrant)}`,
    `🕒 <b>Snapshot:</b> ${html(data.snapshot_time || "غير متاح")}`, "",
    `<i>${source === "cache" ? "📦 المصدر: Cache — لم يتم استهلاك رصيد WHOIS جديد." : "🆕 المصدر: بحث WHOIS جديد — تم احتساب عملية واحدة."}</i>`,
    "<i>ملاحظة: عناوين IP مأخوذة من DNS وقت الطلب، وليست جزءًا من لقطة WHOIS.</i>"
  ].join("\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (!process.env.TELEGRAM_WEBHOOK_SECRET || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) return res.status(401).send("Unauthorized");
  try {
    const callback = req.body?.callback_query;
    const message = req.body?.message || callback?.message;
    const chatId = message?.chat?.id;
    const userId = String((req.body?.message?.from || callback?.from)?.id || "");
    const text = String(req.body?.message?.text || "").trim();
    if (!message || !chatId) return res.status(200).json({ ok: true });
    if (userId !== String(process.env.TELEGRAM_ALLOWED_USER_ID || "")) {
      await reply(chatId, "⛔ هذا البوت خاص وغير مصرح لحسابك باستخدامه.");
      return res.status(200).json({ ok: true });
    }

    // Inline menu actions
    if (callback) {
      const action = String(callback.data || "");
      await answerCallback(callback.id, "جارٍ التنفيذ...");
      if (action.startsWith("whois:")) {
        const domain = normalizeDomain(action.slice(6));
        if (!domain) await reply(chatId, "⚠️ اسم الدومين غير صحيح.");
        else {
          const result = await lookupDomain(domain);
          if (result.kind === "rate") await reply(chatId, "⏱️ انتظر ثانية واحدة قبل البحث التالي.");
          else if (result.kind === "limit") await reply(chatId, "🛑 وصلت إلى الحد الشهري (500 بحث).");
          else await reply(chatId, await formatWhois(domain, result.data, result.kind), domainKeyboard(domain));
        }
      } else if (action.startsWith("add:")) {
        const domain = normalizeDomain(action.slice(4));
        if (!domain) await reply(chatId, "⚠️ اسم الدومين غير صحيح.");
        else {
          const result = await addPortfolioDomain({ domain });
          await reply(chatId, result.error ? `⚠️ ${html(result.error)}` : `✅ تمت إضافة <b>${html(domain)}</b> إلى المحفظة. يمكنك تعديل سعر الشراء والتجديد لاحقاً باستخدام /edit.`);
        }
      } else if (action === "portfolio") await reply(chatId, portfolioText(await getPortfolio()));
      else if (action === "usage") {
        const usage = await getUsage();
        await reply(chatId, `📊 <b>استهلاك ${new Date().toISOString().slice(0, 7)}</b>\n\nالمستخدم: ${usage.used}/${usage.limit}\nالمتبقي: ${usage.remaining}`);
      } else if (action === "help") await reply(chatId, portfolioHelp());
      return res.status(200).json({ ok: true });
    }

    // Domain Investor Pro — private portfolio commands
    if (/^\/help(?:@\w+)?$/.test(text)) {
      await reply(chatId, portfolioHelp());
      return res.status(200).json({ ok: true });
    }
    if (/^\/portfolio(?:@\w+)?$/.test(text)) {
      await reply(chatId, portfolioText(await getPortfolio()));
      return res.status(200).json({ ok: true });
    }
    if (/^\/add(?:@\w+)?(?:\s|$)/i.test(text)) {
      const p = text.replace(/^\/add(?:@\w+)?\s*/i, "").split("|").map(x => x.trim());
      if (!p[0]) {
        await reply(chatId, portfolioHelp());
      } else {
        const buy = optionalMoney(p[1], "سعر الشراء");
        const renewal = optionalMoney(p[5], "تكلفة التجديد");
        const target = optionalMoney(p[6], "سعر البيع المستهدف");
        const invalid = buy.error || renewal.error || target.error;
        if (invalid) await reply(chatId, `⚠️ ${html(invalid)}`);
        else {
          const result = await addPortfolioDomain({
            domain: p[0], buyPrice: buy.value, buyDate: p[2] || null,
            registrar: p[3] || null, renewalDate: p[4] || null,
            renewalCost: renewal.value, targetPrice: target.value
          });
          await reply(chatId, result.error
            ? `⚠️ ${html(result.error)}`
            : `✅ تمت إضافة <b>${html(result.item.domain)}</b> إلى المحفظة (${result.count}/99).`);
        }
      }
      return res.status(200).json({ ok: true });
    }
    if (/^\/edit(?:@\w+)?(?:\s|$)/i.test(text)) {
      const p = text.replace(/^\/edit(?:@\w+)?\s*/i, "").split("|").map(x => x.trim());
      if (p.length < 3) await reply(chatId, portfolioHelp());
      else {
        const result = await updatePortfolioDomain(p[0], p[1], p.slice(2).join("|"));
        await reply(chatId, result.error
          ? `⚠️ ${html(result.error)}`
          : `✅ تم تحديث بيانات <b>${html(result.item.domain)}</b>.`);
      }
      return res.status(200).json({ ok: true });
    }
    if (/^\/remove(?:@\w+)?(?:\s|$)/i.test(text)) {
      const domain = text.replace(/^\/remove(?:@\w+)?\s*/i, "").trim();
      if (!domain) await reply(chatId, portfolioHelp());
      else {
        const result = await removePortfolioDomain(domain);
        await reply(chatId, result.error
          ? `⚠️ ${html(result.error)}`
          : `🗑️ تم حذف الدومين. المتبقي: ${result.count}/99.`);
      }
      return res.status(200).json({ ok: true });
    }

    if (text === "/start") {
      await reply(chatId, ["👋 <b>مرحباً بك في WHOIS Bot الخاص بك</b>", "", "أرسل اسم الدومين مباشرة:", "<code>example.com</code> — بحث WHOIS مع أزرار تفاعلية", "أو استخدم:", "<code>/whois example.com</code> — البحث عن دومين", "<code>/usage</code> — رصيد الشهر", "<code>/portfolio</code> — عرض المحفظة", "<code>/add</code> — إضافة دومين", "<code>/edit</code> — تعديل بيانات", "<code>/remove</code> — حذف دومين", "<code>/help</code> — مساعدة المحفظة", "", "يتضمن التقرير عمر الدومين، الأيام المتبقية، التصنيف، وعناوين IPv4/IPv6.", "ملاحظة: النتائج المخزنة لا تستهلك رصيد WHOIS جديداً."].join("\n"));
    } else if (text === "/usage") {
      const usage = await getUsage();
      await reply(chatId, `📊 <b>استهلاك ${new Date().toISOString().slice(0, 7)}</b>\n\nالمستخدم: ${usage.used}/${usage.limit}\nالمتبقي: ${usage.remaining}`);
    } else if (text.startsWith("/whois")) {
      const raw = text.replace(/^\/whois(?:@\w+)?\s*/i, "");
      const domain = normalizeDomain(raw);
      if (!domain) await reply(chatId, "⚠️ أرسل دوميناً صحيحاً، مثال:\n<code>/whois example.com</code>");
      else {
        await reply(chatId, `⏳ جارٍ البحث عن <b>${html(domain)}</b>...`);
        const result = await lookupDomain(domain);
        if (result.kind === "rate") await reply(chatId, "⏱️ انتظر ثانية واحدة قبل البحث التالي.");
        else if (result.kind === "limit") await reply(chatId, "🛑 وصلت إلى الحد الشهري (500 بحث).");
        else await reply(chatId, await formatWhois(domain, result.data, result.kind), domainKeyboard(domain));
      }
    } else {
      const nakedDomain = normalizeDomain(text);
      if (nakedDomain) {
        await reply(chatId, `⏳ جارٍ البحث عن <b>${html(nakedDomain)}</b>...`);
        const result = await lookupDomain(nakedDomain);
        if (result.kind === "rate") await reply(chatId, "⏱️ انتظر ثانية واحدة قبل البحث التالي.");
        else if (result.kind === "limit") await reply(chatId, "🛑 وصلت إلى الحد الشهري (500 بحث).");
        else await reply(chatId, await formatWhois(nakedDomain, result.data, result.kind), domainKeyboard(nakedDomain));
      } else await reply(chatId, "أرسل اسم الدومين فقط مثل <code>ebaio.com</code>، أو استخدم /help.");
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    try { const chatId = req.body?.message?.chat?.id; if (chatId) await reply(chatId, "حدث خطأ مؤقت أثناء تنفيذ الطلب. حاول لاحقاً."); } catch {}
    return res.status(200).json({ ok: true });
  }
}
