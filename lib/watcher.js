const { execFileSync } = require('node:child_process');

function runGit(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
  });
}

function parseStatusLine(line) {
  const status = line.slice(0, 2);
  let path = line.slice(3);

  const renameSeparator = ' -> ';
  const renameIndex = path.indexOf(renameSeparator);
  if (renameIndex !== -1) {
    path = path.slice(renameIndex + renameSeparator.length);
  }

  return { path, status };
}

function getChanges(repoPath) {
  const statusOutput = runGit(repoPath, ['status', '--porcelain']);
  const stat = runGit(repoPath, ['diff', '--stat']);
  const files = statusOutput.split('\n').filter(Boolean).map(parseStatusLine);

  return { files, stat };
}

function filePathKey(changes) {
  return changes.files
    .map((file) => file.path)
    .sort()
    .join('\0');
}

function watch(repoPath, onChange, intervalMs = 1500) {
  let previousKey = filePathKey(getChanges(repoPath));

  const interval = setInterval(() => {
    const changes = getChanges(repoPath);
    const nextKey = filePathKey(changes);

    if (nextKey !== previousKey) {
      previousKey = nextKey;
      onChange(changes);
    }
  }, intervalMs);

  return function stop() {
    clearInterval(interval);
  };
}

module.exports = {
  getChanges,
  watch,
};
