/* Places where the program does something only if a hook is set. The
   optional dev package sets them; without it each one is simply absent.

     callerHistory(query)   show the earlier tickets for a caller
*/

const hooks = {};

export function setHook(name, fn) { hooks[name] = fn; }

export function hook(name) { return hooks[name] || null; }
