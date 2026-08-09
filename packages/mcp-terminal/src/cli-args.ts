export interface ParsedArgs {
  sandboxRoot?: string;
  allowExec: boolean;
  port: number;
  relayUrl: string;
  noOpen: boolean;
}

const DEFAULT_RELAY_URL = 'https://htmlpaint.com/human-mcp/relay.js';

export function parseArgs(argv: string[]): ParsedArgs {
  let args: ParsedArgs = {
    sandboxRoot: undefined,
    allowExec: false,
    port: 8799,
    relayUrl: DEFAULT_RELAY_URL,
    noOpen: false,
  };

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    switch (arg) {
      case '--allow-exec':
        args.allowExec = true;
        break;
      case '--dir':
        args.sandboxRoot = argv[++i];
        break;
      case '--port':
        args.port = Number(argv[++i]);
        break;
      case '--relay-url':
        args.relayUrl = argv[++i];
        break;
      case '--no-open':
        args.noOpen = true;
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown flag: ${arg}`);
        }
    }
  }

  return args;
}
