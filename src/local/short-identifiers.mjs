export function shortCallId(value) {
  const text = String(value || "");
  return text.length <= 18 ? text : `${text.slice(0, 10)}...${text.slice(-5)}`;
}
