import { normalizeDomain } from "../lib/domain.js";
import { getUsage, lookupDomain } from "../lib/whois.js";

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

async function reply(chatId, text) {
  return telegram("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
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
    const message = req.body?.message;
    const chatId = message?.chat?.id;
    const userId = String(message?.from?.id || "");
    const text = String(message?.text || "").trim();
    if (!message || !chatId) return res.status(200).json({ ok: true });
    if (userId !== String(process.env.TELEGRAM_ALLOWED_USER_ID || "")) {
      await reply(chatId, "⛔ هذا البوت خاص وغير مصرح لحسابك باستخدامه.");
      return res.status(200).json({ ok: true });
    }
    if (text === "/start") {
      await reply(chatId, ["👋 <b>مرحباً بك في WHOIS Bot الخاص بك</b>", "", "أرسل:", "<code>/whois example.com</code> — البحث عن دومين", "<code>/usage</code> — رصيد الشهر", "", "يتضمن التقرير عمر الدومين، الأيام المتبقية، التصنيف، وعناوين IPv4/IPv6.", "ملاحظة: النتائج المخزنة لا تستهلك رصيد WHOIS جديداً."].join("\n"));
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
        else await reply(chatId, await formatWhois(domain, result.data, result.kind));
      }
    } else await reply(chatId, "استخدم /whois domain.com أو /usage");
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    try { const chatId = req.body?.message?.chat?.id; if (chatId) await reply(chatId, "حدث خطأ مؤقت أثناء تنفيذ الطلب. حاول لاحقاً."); } catch {}
    return res.status(200).json({ ok: true });
  }
}
