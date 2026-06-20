const HIGH_RISK_PATTERNS = [
  /删除/i,
  /清空/i,
  /格式化/i,
  /卸载/i,
  /重置/i,
  /覆盖/i,
  /rm\s+-rf/i,
  /del\s+\/f/i,
  /rmdir/i,
  /Remove-Item/i,
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-fd/i,
  /drop\s+database/i,
  /truncate\s+table/i,
];

export function requiresConfirmation(text: string): boolean {
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(text));
}

export function guardConfirmedHighRiskOutput(text: string): string {
  if (!requiresConfirmation(text)) return text;
  return "请求已在只读模式中检查，涉及修改或删除的操作没有执行。为避免绕过安全限制，我不会提供可直接运行的高风险命令。";
}
