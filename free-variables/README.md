# 基于 Acorn 的自由变量分析（Free-Variable Analysis）

只做**静态分析**：用 [Acorn](../../acorn) 把源码解析成 AST，然后遍历 AST
建立作用域链、登记绑定（binding）、解析每个标识符引用。

- **不执行任何被分析的代码**；
- **不修改原始 AST**（所有分析状态保存在外部 `WeakMap/Map` 中）；
- 不需要安装依赖、不需要构建，直接引用仓库内的 `acorn/src`（ESM）。

## 作用域与绑定规则

按真实语言规则建立以下作用域（报告中每条引用都带源码位置）：

| 作用域 | 来源 | 绑定 |
| --- | --- | --- |
| `root` | Program（script/module） | 顶层 `var`/`function`/`let`/`const`/`class`/`import` |
| `params` | 函数参数作用域 | 形参、解构参数；**默认值在此求值**（可引用前序形参与外层绑定，但看不到函数体里的 `var`） |
| `function` | 函数体 | 体内 `var`/函数声明提升到此；非箭头函数在此拥有隐式 `arguments` |
| `block` | `{}`、`for/for-in/for-of` 头部、class 名/class 体、`static {}` | `let`/`const`/`class`（块级函数声明在严格模式下也为块级） |
| `catch` | `catch (e)` | `e`（可解构），仅 catch 块内可见 |
| `with` | `with (o)` | **动态作用域**，不猜测，见“未知” |

其他语言规则：

- **成员名不是变量**：`obj.x`、`obj["x"]` 只引用 `obj`；
- **对象字面量的字面键不是变量**：`{x: 1}` 不引用 `x`；
- **计算键是引用**：`obj[k]`、`{[k]: 1}`、`class A { [k](){} }` 中的 `k` 计入；
- **解构默认值是引用**：`var {a = y} = z` 中 `y`、`z` 均计入；解构模式里的计算键也计入；
- **简写属性**：`f({x})` 中的 `x` 是对变量 `x` 的引用；
- **具名函数表达式**：名字只在函数内部（含参数默认值）可见，外部不可见；
- **函数声明**：名字绑定在外层作用域；
- **具名 class 表达式**：名字只在 class 内部可见；
- **`arguments`**：非箭头函数的隐式绑定（报告中 `implicit: true`）；箭头函数没有自己的
  `arguments`，沿作用域向上解析或报为自由；
- **嵌套闭包**：内层引用沿作用域链解析，指回外层绑定；内层同名绑定会遮蔽外层；
- **无声明的赋值/自增目标**（`x = 1`、`x++`、`({a} = o)`）按引用处理；
- `import` 说明符字符串、`this`、`new.target`、`import.meta`、私有字段名 `#x` 不是变量引用。

## 未知（unknown）——不假装分析完整

两类构造在静态下无法判定名字来自哪里，单独列入报告的 `unknown` 字段，并给出原因：

1. **`with` 语句**：块内（含嵌套函数中无法在词法作用域解析的名字）可能在运行时解析为
   对象属性，原因标记为 `"with"`。注意：词法上确实可见的绑定（外层 `let`/形参等）
   仍然正常解析，不会被误标。
2. **直接 eval**：对**未被遮蔽**的标识符 `eval` 的直接调用（`eval("...")`）在非严格
   模式下可能向外层函数作用域注入/删除绑定。该函数作用域标记 `taintedByDirectEval`，
   其中无法解析的名字以原因 `"direct-eval"` 列入未知。调用点本身另列入 `dynamicEval`。
   - 严格模式下的直接 eval 不能向外层加绑定，不产生未知；
   - 间接 eval（`(0, eval)()`）与全局 `eval` 只是普通引用，`eval` 报为自由变量。

## 报告结构

`analyze(code, options?)` 返回：

- `sourceType`：`"script"` 或 `"module"`
- `scopes[]`：`id, kind, parent, strict, loc, bindings(名), taintedByDirectEval`
- `bindings[]`：`name, kind, implicit, scope, loc, references[]`（每个绑定及其引用位置）
- `references[]`：每个标识符引用：`name, loc, assignmentTarget,
  resolved{name,kind,scope}|null, free, unknown, reasons`
- `freeVariables[]`：`{name, loc, assignmentTarget}`
- `unknown[]`：`{name, loc, reasons}`（with / direct-eval）
- `dynamicEval[]`：直接 eval 调用点及其污染的作用域

位置格式：`{start:{line,column,offset}, end:{...}}`，行、列从 1/0 计（Acorn 规则），
offset 为 0 基字符偏移，可直接对源码做切片。

选项：`{ sourceType, ecmaVersion, globals }`；`globals` 为宿主假定提供的全局名
（如 `["console","process"]`），它们既不算自由也不算未知。

## Node 局部命令（无需安装依赖）

在仓库根目录（acorn 源码可直接被 Node 以 ESM 加载）：

```bash
# 跑确定性验收测试（无网络、无第三方依赖）
node free-variables/test/run.js

# 对文件输出完整 JSON 报告
node free-variables/bin/fv.js free-variables/examples/four-scopes.js

# 人类可读摘要（绑定/引用位置、自由变量、未知项）
node free-variables/bin/fv.js --summary free-variables/examples/four-scopes.js
node free-variables/bin/fv.js --summary free-variables/examples/unknown.js

# 从标准输入分析
echo 'function f(a){ return a + b }' | node free-variables/bin/fv.js --summary

# 模块源码 / 假定宿主全局
node free-variables/bin/fv.js --module --globals=console,process app.js

node free-variables/bin/fv.js --help
```

作为库使用：

```js
import {analyze} from "./free-variables/src/index.js"

const report = analyze(`
  function make(a, b = base) {
    const local = obj.x        // 只引用 obj；x 是成员名
    return ({[key]: a, local}) // key 是计算键引用；local 引用自身绑定
  }
`)
console.log(report.freeVariables) // [ {name:'base',...}, {name:'obj',...}, {name:'key',...} ]
```

## 四作用域示例

`examples/four-scopes.js` 在一个程序中覆盖函数（参数+体）、块、catch 和根作用域；
`examples/unknown.js` 演示 `with` 与直接 eval 的未知项。预期：

- four-scopes：自由变量仅 `outer`（参数默认值）和 `maybeGlobal`；
- unknown：`mystery`（with）、`injected`（direct-eval）为未知，`eval` 为自由全局引用，
  参数 `x` 在 with 块内仍正确解析为参数绑定。

## 限制（诚实说明）

- Annex B 的块内函数声明在非严格模式下采用“向外提升”的简化处理；
- 不做类型/值分析：`with` 对象成员、直接 eval 注入名一律列未知而非猜测；
- 全局内置对象（`Object`、`Math` 等）默认仍报自由，可用 `globals` 选项声明；
- 仅基于语法：不区分 `typeof undeclared` 之类运行时不抛错的引用（仍报自由）。
