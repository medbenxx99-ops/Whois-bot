import { normalizeDomain } from "../lib/domain.js";
import { getUsage, lookupDomain } from "../lib/whois.js";

const html = (value = "") => String(value).replace(/[&<>"]/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
}[c]));

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Telegram API error: ${response.status}`);
  return response.json();
}

async function reply(chatId, text) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

function eventDate(data, action) {
  const event = (data.events || []).find(e => String(e.event_action || "").toLowerCase() === action);
  return event?.event_date || "غير متاح";
}

function formatWhois(domain, data, source) {
  const nameservers = (data.nameservers || []).map(n => n.ldh_name || n.name || "").filter(Boolean);
  const statuses = (data.statuses || []).join(", ") || "غير متاح";
  const contacts = data.contacts?.registrant || {};
  const registrant = [contacts.organization, contacts.name, contacts.country, contacts.email]
    .filter(Boolean).join(" · ") || "غير متاح / محجوب";

  return [
    `🔎 <b>WHOIS: ${html(domain)}</b>`,
    "",
    `🏢 <b>Registrar:</b> ${html(data.registrar || "غير متاح")}`,
    `📅 <b>Registration:</b> ${html(eventDate(data, "registration"))}`,
    `⌛ <b>Expiration:</b> ${html(eventDate(data, "expiration"))}`,
    `🔄 <b>Updated:</b> ${html(eventDate(data, "last changed") || data.updated_date || "غير متاح")}`,
    `📌 <b>Status:</b> ${html(statuses)}`,
    `🌐 <b>Name servers:</b> ${html(nameservers.join(", ") || "غير متاح")}`,
    `👤 <b>Registrant:</b> ${html(registrant)}`,
    `🕒 <b>Snapshot:</b> ${html(data.snapshot_time || "غير متاح")}`,
    "",
    `<i>${source === "cache" ? "نتيجة مخزنة — لم يتم استهلاك رصيد جديد." : "بحث جديد — تم احتساب عملية واحدة."}</i>`
  ].join("\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (!process.env.TELEGRAM_WEBHOOK_SECRET || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).send("Unauthorized");
  }

  try {
    const update = req.body;
    const message = update?.message;
    const chatId = message?.chat?.id;
    const userId = String(message?.from?.id || "");
    const text = String(message?.text || "").trim();

    if (!message || !chatId) return res.status(200).json({ ok: true });

    if (userId !== String(process.env.TELEGRAM_ALLOWED_USER_ID || "")) {
      await reply(chatId, "⛔ هذا البوت خاص وغير مصرح لحسابك باستخدامه.");
      return res.status(200).json({ ok: true });
    }

    if (text === "/start") {
      await reply(chatId, [
        "👋 <b>مرحباً بك في WHOIS Bot الخاص بك</b>",
        "",
        "أرسل:",
        "<code>/whois example.com</code> — البحث عن دومين",
        "<code>/usage</code> — رصيد الشهر",
        "",
        "ملاحظة: النتائج المخزنة لا تستهلك رصيداً جديداً."
      ].join("\n"));
    } else if (text === "/usage") {
      const usage = await getUsage();
      await reply(chatId, `📊 <b>استهلاك ${new Date().toISOString().slice(0, 7)}</b>\n\nالمستخدم: ${usage.used}/${usage.limit}\nالمتبقي: ${usage.remaining}`);
    } else if (text.startsWith("/whois")) {
      const raw = text.replace(/^\/whois(?:@\w+)?\s*/i, "");
      const domain = normalizeDomain(raw);
      if (!domain) {
        await reply(chatId, "⚠️ أرسل دوميناً صحيحاً، مثال:\n<code>/whois example.com</code>");
      } else {
        await reply(chatId, `⏳ جارٍ البحث عن <b>${html(domain)}</b>...`);
        const result = await lookupDomain(domain);
        if (result.kind === "rate") {
          await reply(chatId, "⏱️ انتظر ثانية واحدة قبل البحث التالي.");
        } else if (result.kind === "limit") {
          await reply(chatId, "🛑 وصلت إلى الحد الشهري (500 بحث).");
        } else {
          await reply(chatId, formatWhois(domain, result.data, result.kind));
        }
      }
    } else {
      await reply(chatId, "استخدم /whois domain.com أو /usage");
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    try {
      const chatId = req.body?.message?.chat?.id;
      if (chatId) await reply(chatId, "حدث خطأ مؤقت أثناء تنفيذ الطلب. حاول لاحقاً.");
    } catch {}
    return res.status(200).json({ ok: true });
  }
}