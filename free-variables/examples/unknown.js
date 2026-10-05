// `with` and direct eval make static resolution incomplete. These names are
// reported under `unknown`, never silently treated as free or bound.

function dynamic(obj, x) {
  with (obj) {
    mystery + x                  // `mystery` may be obj.mystery -> unknown
  }
  var leaked = "before eval"
  eval("var injected = 1")       // direct eval can add `injected`
  return injected + leaked       // `injected` -> unknown (direct-eval)
}
