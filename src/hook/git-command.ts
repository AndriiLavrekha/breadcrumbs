// A small shell-aware reader for the commit guard. It splits a Bash command into segments at unquoted
// separators and reads each `git commit` / `git add` for what it would stage. It is not a shell parser:
// shortcut: variable expansion, aliases and pathspec magic such as `:(glob)**` are not understood, extend if seen.

export interface GitCommitInvocation {
  // `-a` / `--all`: stages tracked changes.
  stagesTracked: boolean;
  // A positional path that names project-progress.
  namesProgress: boolean;
  // A positional pathspec such as `.` or `*` that includes tracked progress files.
  broadPathspec: boolean;
}

export interface GitAddInvocation {
  broad: boolean;
  namesProgress: boolean;
}

export interface GitCommandAnalysis {
  commits: GitCommitInvocation[];
  adds: GitAddInvocation[];
}

const SEPARATORS = new Set([";", "&", "|", "\n", "(", ")", "{", "}", "`"]);
const WRAPPERS = new Set(["!", "time", "sudo", "command", "exec", "nohup", "env", "if", "then", "do", "else", "elif", "while", "until"]);
const OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const LONG_COMMIT_OPTIONS_WITH_VALUE = new Set([
  "--message", "--file", "--reuse-message", "--reedit-message", "--author", "--date", "--template", "--fixup", "--squash", "--cleanup"
]);
// Short commit options whose value is the rest of the token, or the next token when the option ends the group.
const SHORT_COMMIT_VALUE_OPTIONS = "mFCct";
const BROAD_PATHSPECS = new Set([".", "./", ":/"]);

function splitSegments(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;

  const endToken = () => {
    if (inToken) tokens.push(token);
    token = "";
    inToken = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < command.length) token += command[++i];
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inToken = true;
    } else if (char === "\\" && i + 1 < command.length) {
      token += command[++i];
      inToken = true;
    } else if (SEPARATORS.has(char)) {
      endSegment();
    } else if (/\s/.test(char)) {
      endToken();
    } else {
      token += char;
      inToken = true;
    }
  }
  endSegment();
  return segments;
}

function isGit(token: string): boolean {
  return /(^|[\\/])git(\.exe)?$/.test(token);
}

function isGlob(token: string): boolean {
  return token.includes("*") || token.includes("?");
}

function readCommit(args: string[]): GitCommitInvocation {
  const result: GitCommitInvocation = { stagesTracked: false, namesProgress: false, broadPathspec: false };
  let valueNext = false;
  let positionalOnly = false;
  for (const arg of args) {
    if (valueNext) {
      valueNext = false;
    } else if (positionalOnly || !arg.startsWith("-")) {
      if (arg.replace(/\\/g, "/").includes("project-progress")) result.namesProgress = true;
      else if (BROAD_PATHSPECS.has(arg) || isGlob(arg)) result.broadPathspec = true;
    } else if (arg === "--") {
      positionalOnly = true;
    } else if (arg.startsWith("--")) {
      if (arg === "--all") result.stagesTracked = true;
      else if (LONG_COMMIT_OPTIONS_WITH_VALUE.has(arg)) valueNext = true;
    } else {
      for (let i = 1; i < arg.length; i++) {
        const flag = arg[i];
        if (flag === "a") result.stagesTracked = true;
        if (flag === "S" || flag === "u") break;
        if (SHORT_COMMIT_VALUE_OPTIONS.includes(flag)) {
          if (i === arg.length - 1) valueNext = true;
          break;
        }
      }
    }
  }
  return result;
}

function readAdd(args: string[]): GitAddInvocation {
  const result: GitAddInvocation = { broad: false, namesProgress: false };
  let positionalOnly = false;
  for (const arg of args) {
    if (positionalOnly || !arg.startsWith("-")) {
      if (arg.replace(/\\/g, "/").includes("project-progress")) result.namesProgress = true;
      else if (BROAD_PATHSPECS.has(arg) || isGlob(arg)) result.broad = true;
    } else if (arg === "--") {
      positionalOnly = true;
    } else if (arg.startsWith("--")) {
      if (arg === "--all" || arg === "--update") result.broad = true;
    } else if (/[Au]/.test(arg)) {
      result.broad = true;
    }
  }
  return result;
}

export function analyzeGitCommand(command: string): GitCommandAnalysis {
  const analysis: GitCommandAnalysis = { commits: [], adds: [] };
  for (const tokens of splitSegments(command)) {
    let index = 0;
    while (index < tokens.length && (WRAPPERS.has(tokens[index]) || /^\w+=/.test(tokens[index]))) index++;
    if (index >= tokens.length || !isGit(tokens[index])) continue;
    index++;
    while (index < tokens.length && tokens[index].startsWith("-")) {
      index += OPTIONS_WITH_VALUE.has(tokens[index]) ? 2 : 1;
    }
    const subcommand = tokens[index];
    const args = tokens.slice(index + 1);
    if (subcommand === "commit") analysis.commits.push(readCommit(args));
    else if (subcommand === "add") analysis.adds.push(readAdd(args));
  }
  return analysis;
}
