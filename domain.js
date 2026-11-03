export function normalizeDomain(input) {
  const value = String(input || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#\s]/)[0]
    .replace(/\.$/, "");

  if (!value || value.length > 253 || !value.includes(".")) return null;
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/.test(value)) {
    return null;
  }
  return value;
}