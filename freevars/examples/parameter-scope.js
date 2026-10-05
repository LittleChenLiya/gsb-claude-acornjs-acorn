// 参数作用域：参数默认值引用外层变量与更早的参数；
// arguments 只在普通函数内绑定，箭头函数没有自己的 arguments。
function f(a = outer, b = a + 1) {
  return a + b + arguments.length
}
const outer = 1
const arrow = (x = outer) => x + arguments
f()
arrow()
