// 块作用域：let/const 绑定在块内，块外不可见；
// for 循环的迭代变量绑定在 for 块作用域。
function f(n) {
  let out = 0
  for (let i = 0; i < n; i++) {
    const blockLocal = i
    out += blockLocal
  }
  if (n > 0) {
    let branchLocal = n
    out += branchLocal
  }
  return out
}
f(3)
