// 函数作用域：var 与函数声明绑定在函数内部，外层不可见；
// 嵌套闭包引用外层绑定。
function outer(x) {
  var localVar = 1
  function inner() {
    var innerVar = 2
    // localVar 与 x 都解析到 outer 的绑定 -> 对 inner 而言是自由变量
    return localVar + innerVar + x
  }
  return inner()
}
outer(0)
