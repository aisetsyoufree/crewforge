function stripTrailingZero(value) {
  return value.toFixed(1).replace(/\.0$/, '');
}

function humanTokens(n) {
  if (n < 1000) {
    return String(n);
  }

  if (n < 1000000) {
    return `${stripTrailingZero(n / 1000)}k`;
  }

  return `${stripTrailingZero(n / 1000000)}M`;
}

function humanDuration(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);

  if (seconds < 60) {
    return `${stripTrailingZero(ms / 1000)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  return `${minutes}m ${remainingSeconds}s`;
}

function truncate(str, n) {
  if (str.length > n) {
    return `${str.slice(0, n)}…`;
  }

  return str;
}

module.exports = {
  humanTokens,
  humanDuration,
  truncate,
};
