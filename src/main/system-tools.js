'use strict';

/**
 * The operating system's own programs, by full path.
 *
 * Named bare, `powershell.exe` is looked for first in the folder the running
 * program lives in - on Windows that search starts beside `Debrowser.exe`,
 * which a per-user install puts in a folder the user (and anything running
 * as them) can write to. A file dropped there under that name would run in
 * place of the real one, with whatever the browser handed it. Spelled out,
 * there is nothing to search.
 */

const path = require('path');

const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';

const POWERSHELL = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

module.exports = { POWERSHELL, OPEN: '/usr/bin/open', PKEXEC: '/usr/bin/pkexec' };
