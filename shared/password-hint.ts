/**
 * 主密码提示的最大长度（字符）。前后端共用，避免「前端能输入 / 后端 400」的错位。
 * 服务端经 `LIMITS.auth.passwordHintMaxLength` 引用同一值。
 */
export const PASSWORD_HINT_MAX_LENGTH = 120;
