// Pure path-normalisation and access-control functions.
// denyPaths is passed explicitly so these functions are side-effect-free and testable.

export function normPath(...parts) {
  const joined = parts.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  const segments = [];
  for (const seg of joined.split('/')) {
    if (seg === '..') segments.pop();
    else if (seg && seg !== '.') segments.push(seg);
  }
  return segments.join('/');
}

export function isDenied(denyPaths, path) {
  if (!denyPaths.length || !path) return false;
  const p = normPath(path);
  return denyPaths.some(denied => p === denied || p.startsWith(denied + '/'));
}

// Returns an error message string if the tool call should be blocked, else null.
export function checkAccess(denyPaths, toolName, args) {
  if (!denyPaths.length) return null;

  switch (toolName) {
    case 'read-note':
    case 'create-note':
    case 'edit-note': {
      const p = normPath(args.folder, args.filename);
      if (isDenied(denyPaths, p)) return `Access denied: '${p}' is restricted`;
      break;
    }

    case 'delete-note': {
      const p = normPath(args.path);
      if (isDenied(denyPaths, p)) return `Access denied: '${p}' is restricted`;
      break;
    }

    case 'move-note': {
      const src = normPath(args.source);
      const dst = normPath(args.destination);
      if (isDenied(denyPaths, src)) return `Access denied: source '${src}' is restricted`;
      if (isDenied(denyPaths, dst)) return `Access denied: destination '${dst}' is restricted`;
      break;
    }

    case 'add-tags':
    case 'remove-tags': {
      const files = Array.isArray(args.files) ? args.files : [];
      const blocked = files.map(f => normPath(f)).find(f => isDenied(denyPaths, f));
      if (blocked) return `Access denied: '${blocked}' is restricted`;
      break;
    }

    case 'create-directory': {
      const p = normPath(args.path);
      if (isDenied(denyPaths, p)) return `Access denied: '${p}' is restricted`;
      break;
    }

    case 'search-vault': {
      if (args.path) {
        const p = normPath(args.path);
        if (isDenied(denyPaths, p)) return `Access denied: '${p}' is restricted`;
      }
      break;
    }
  }
  return null;
}
