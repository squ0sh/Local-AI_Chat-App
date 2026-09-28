const SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'branch', 'ls-files', 'rev-parse', 'remote', 'tag']);
const ALWAYS_DENIED = /^(?:-c|--config-env|--exec|--ext-diff|--textconv|--no-index|--output(?:=|$)|--paginate|--git-dir|--work-tree)/;

function flagsOnly(args, allowed) {
  return args.every((arg) => allowed.has(arg) || [...allowed].some((flag) => flag.endsWith('=') && arg.startsWith(flag)));
}

export function safeGitArguments(input) {
  if (!Array.isArray(input) || !input.length || input.length > 16) {
    return { ok: false, error: 'Git needs one read-only subcommand and at most 15 arguments' };
  }
  const argv = input.map(String);
  if (argv.join(' ').length > 500 || argv.some((arg) => /[\r\n\0]/.test(arg) || arg.length > 300)) {
    return { ok: false, error: 'Git arguments are too large' };
  }
  const subcommand = argv[0];
  const args = argv.slice(1);
  if (!SUBCOMMANDS.has(subcommand)) {
    return { ok: false, error: 'Git subcommand is not in the read-only allowlist' };
  }
  if (args.some((arg) => ALWAYS_DENIED.test(arg))) {
    return { ok: false, error: 'Git execution, output, config, and external-diff options are not allowed' };
  }

  let valid = false;
  if (subcommand === 'status') {
    valid = flagsOnly(args, new Set(['--short', '-s', '--branch', '-b', '--porcelain', '--porcelain=', '--untracked-files=', '-uno', '-unormal', '-uall']));
  } else if (subcommand === 'branch') {
    valid = flagsOnly(args, new Set(['--list', '-l', '--all', '-a', '--remotes', '-r', '--show-current', '-v', '-vv', '--no-color', '--contains=']));
  } else if (subcommand === 'remote') {
    valid = args.length === 0 || (args.length === 1 && args[0] === '-v');
  } else if (subcommand === 'tag') {
    valid = flagsOnly(args, new Set(['--list', '-l', '--no-color', '--sort=']));
  } else if (subcommand === 'rev-parse') {
    const allowed = new Set(['HEAD', '--show-toplevel', '--show-prefix', '--show-cdup', '--is-inside-work-tree', '--is-bare-repository', '--abbrev-ref']);
    valid = args.length > 0 && args.every((arg) => allowed.has(arg));
  } else {
    // diff/log/show/ls-files are read-only, but reject every option that can
    // execute a helper or write output. Remaining refs and repo-relative paths
    // are passed without a shell.
    valid = args.every((arg) => !arg.startsWith('-')
      || arg === '--'
      || /^-(?:n\d+|p|u|w)$/.test(arg)
      || /^(?:--stat|--shortstat|--name-only|--name-status|--oneline|--decorate|--graph|--all|--no-color|--relative|--cached|--staged|--reverse)$/.test(arg)
      || /^(?:--max-count|--since|--until|--format|--pretty|--abbrev|--diff-filter)=.{1,120}$/.test(arg));
  }
  if (!valid) return { ok: false, error: 'Arguments are outside the read-only git grammar' };

  const hardened = ['-c', 'core.pager=cat', '-c', 'diff.external=', '--no-pager', subcommand];
  if (['diff', 'log', 'show'].includes(subcommand)) hardened.push('--no-ext-diff', '--no-textconv');
  hardened.push(...args);
  return { ok: true, args: hardened };
}
