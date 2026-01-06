export const MCP_SESSION_ID_HEADER = "mcp-session-id";
export const MAX_WORKSPACE_FILES = 2000; // keep it lightweight
export const MAX_SELECTION_LEN = 16 * 1024; // 16 KiB
export const MAX_VISIBLE_LINES = 80;
export const MAX_VISIBLE_CHARS = 6 * 1024; // 6 KiB to keep prompts small
export const CONTEXT_DEBOUNCE_MS = 75;
export const WORKSPACE_FILE_EXCLUDES =
    "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**,**/build/**,**/.voice/**}";
export const DEFAULT_REGISTRY_FILENAME = `voice-coding-ide-servers.json`;
export const REGISTRY_ENV = "VOICE_CODING_IDE_SERVERS_REGISTRY";
export const CURSOR_CONTEXT = 30; // lines above and below cursor to include in context
