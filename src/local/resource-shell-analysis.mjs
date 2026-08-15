import { basename } from "node:path";
import { heavyScriptName } from "./resource-script-classification.mjs";

export function shellPayload(base, args) {
  if (!["zsh", "bash", "sh", "powershell.exe", "pwsh", "cmd.exe"].includes(base)) return "";
  const index = args.findIndex((entry) => ["-c", "-command", "/c"].includes(entry.toLowerCase()));
  return index >= 0 ? String(args[index + 1] || "") : args.join(" ");
}

export function shellSegments(text) {
  return String(text || "").split(/&&|\|\||[;|()\n]/).map((value) => value.trim()).filter(Boolean);
}

export function commandTokens(segment) {
  const tokens = String(segment).trim().split(/\s+/).filter(Boolean); let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || ["env", "command", "exec", "time"].includes(token)) { index += 1; continue; }
    if (token === "nice") { index += 1; if (tokens[index] === "-n") index += 2; else if (/^-?\d+$/.test(tokens[index] || "")) index += 1; continue; }
    break;
  }
  return tokens.slice(index).map((value, tokenIndex) => tokenIndex ? value : basename(value).toLowerCase());
}

export function shellCommandHeads(text) {
  return shellSegments(text).map((segment) => commandTokens(segment)[0]).filter(Boolean);
}

export function commandHeadIs(text, base, command) {
  return base === command || shellCommandHeads(text).includes(command);
}

export function commandHeadIn(text, base, commands) {
  return commands.includes(base) || shellCommandHeads(text).some((value) => commands.includes(value));
}

export function pythonModuleHeadIs(text, base, module) {
  if (/^python(?:3(?:\.\d+)?)?$/.test(base)) return String(text).includes(`-m ${module}`);
  return shellSegments(text).some((segment) => pythonModuleTokens(commandTokens(segment), module));
}

export function pythonModuleTokens(tokens, module) {
  return /^python(?:3(?:\.\d+)?)?$/.test(tokens[0] || "") && tokens[1] === "-m" && tokens[2] === module;
}

export function heavyShellScript(args, text) {
  const commandString = args.some((value) => String(value).toLowerCase() === "-c");
  const direct = commandString ? null : args.find((value) => !String(value).startsWith("-"));
  if (direct && heavyScriptName(direct)) return true;
  return shellSegments(text).some((segment) => {
    const tokens = commandTokens(segment);
    if (!tokens.length) return false;
    if (heavyScriptName(tokens[0])) return true;
    if (!["sh", "bash", "zsh"].includes(tokens[0])) return false;
    const script = tokens.slice(1).find((token) => !String(token).startsWith("-"));
    return Boolean(script && heavyScriptName(script));
  });
}
