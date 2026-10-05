// Scope example 1 - function parameter scope.
//
// Rename the parameter `x` to `p`:
//   node tools/rename-binding/cli.js --old x --new p examples/1-param-shorthand.js
//
// Expected result:
//   function f(p) {
//     const point = {x: p} // object shorthand keeps the external key "x"
//     return point.x + z.x // member properties are not references, untouched
//   }
function f(x) {
  const point = {x}
  return point.x + z.x
}
