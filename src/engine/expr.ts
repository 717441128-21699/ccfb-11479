/**
 * 极小表达式求值器, 支持字段引用 $name、算术/比较/逻辑运算与括号。
 * 用于 FieldDef.when 条件解析。
 */

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lp' }
  | { t: 'rp' };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '(') { tokens.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { tokens.push({ t: 'rp' }); i++; continue; }
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      let s = '';
      while (j < expr.length && expr[j] !== q) { s += expr[j]; j++; }
      tokens.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < expr.length && /[A-Za-z0-9_.\[\]]/.test(expr[j])) j++;
      tokens.push({ t: 'ref', v: expr.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      let hex = false;
      if (c === '0' && (expr[i + 1] === 'x' || expr[i + 1] === 'X')) {
        hex = true;
        j = i + 2;
        while (j < expr.length && /[0-9a-fA-F]/.test(expr[j])) j++;
        tokens.push({ t: 'num', v: parseInt(expr.slice(i, j), 16) });
      } else {
        while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
        tokens.push({ t: 'num', v: parseFloat(expr.slice(i, j)) });
      }
      void hex;
      i = j;
      continue;
    }
    const two = expr.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) {
      tokens.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if (['>', '<', '+', '-', '*', '/', '!'].includes(c)) {
      tokens.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new Error(`表达式无法识别字符: ${c} (位于 ${i})`);
  }
  return tokens;
}

class Parser {
  private p = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined { return this.tokens[this.p]; }
  private next(): Token { return this.tokens[this.p++]; }

  parse(scope: (name: string) => unknown): unknown {
    const v = this.parseOr(scope);
    return v;
  }

  private parseOr(scope: (name: string) => unknown): unknown {
    let left = this.parseAnd(scope);
    while (this.peek()?.t === 'op' && (this.peek() as { v: string }).v === '||') {
      this.next();
      const right = this.parseAnd(scope);
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  private parseAnd(scope: (name: string) => unknown): unknown {
    let left = this.parseEq(scope);
    while (this.peek()?.t === 'op' && (this.peek() as { v: string }).v === '&&') {
      this.next();
      const right = this.parseEq(scope);
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  private parseEq(scope: (name: string) => unknown): unknown {
    let left = this.parseCmp(scope);
    while (this.peek()?.t === 'op' && ['==', '!='].includes((this.peek() as { v: string }).v)) {
      const op = (this.next() as { v: string }).v;
      const right = this.parseCmp(scope);
      // 宽松相等: 数字字符串可比较
      left = op === '==' ? left == right : left != right;
    }
    return left;
  }

  private parseCmp(scope: (name: string) => unknown): unknown {
    let left = this.parseAdd(scope);
    while (this.peek()?.t === 'op' && ['>', '<', '>=', '<='].includes((this.peek() as { v: string }).v)) {
      const op = (this.next() as { v: string }).v;
      const right = this.parseAdd(scope);
      const a = Number(left);
      const b = Number(right);
      left = op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : a <= b;
    }
    return left;
  }

  private parseAdd(scope: (name: string) => unknown): unknown {
    let left = this.parseMul(scope);
    while (this.peek()?.t === 'op' && ['+', '-'].includes((this.peek() as { v: string }).v)) {
      const op = (this.next() as { v: string }).v;
      const right = this.parseMul(scope);
      left = op === '+' ? Number(left) + Number(right) : Number(left) - Number(right);
    }
    return left;
  }

  private parseMul(scope: (name: string) => unknown): unknown {
    let left = this.parseUnary(scope);
    while (this.peek()?.t === 'op' && ['*', '/'].includes((this.peek() as { v: string }).v)) {
      const op = (this.next() as { v: string }).v;
      const right = this.parseUnary(scope);
      left = op === '*' ? Number(left) * Number(right) : Number(left) / Number(right);
    }
    return left;
  }

  private parseUnary(scope: (name: string) => unknown): unknown {
    if (this.peek()?.t === 'op' && (this.peek() as { v: string }).v === '!') {
      this.next();
      return !Boolean(this.parseUnary(scope));
    }
    if (this.peek()?.t === 'op' && (this.peek() as { v: string }).v === '-') {
      this.next();
      return -Number(this.parseUnary(scope));
    }
    return this.parsePrimary(scope);
  }

  private parsePrimary(scope: (name: string) => unknown): unknown {
    const tk = this.next();
    if (!tk) throw new Error('表达式意外结束');
    if (tk.t === 'num') return tk.v;
    if (tk.t === 'str') return tk.v;
    if (tk.t === 'ref') return scope(tk.v);
    if (tk.t === 'lp') {
      const v = this.parseOr(scope);
      if (this.next()?.t !== 'rp') throw new Error('缺少右括号');
      return v;
    }
    throw new Error('表达式语法错误');
  }
}

export function evalExpr(expr: string, scope: (name: string) => unknown): unknown {
  const parser = new Parser(tokenize(expr));
  return parser.parse(scope);
}

export function evalTruthy(expr: string | undefined, scope: (name: string) => unknown): boolean {
  if (!expr) return true;
  return Boolean(evalExpr(expr, scope));
}
