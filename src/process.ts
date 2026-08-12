export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  timeout: number;
  signal?: AbortSignal;
}

export type CommandExecutor = (command: string, args: string[], options: CommandOptions) => Promise<CommandResult>;
