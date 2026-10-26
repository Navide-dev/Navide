# Frozen copy of RELATIVE_IMPORTS_PY from .githooks/pre-commit before the scan
# was made linear. preCommitImportsEquivalence.test.ts holds the hook to its output.
import re, sys
src = sys.stdin.read()
if sys.argv[1].endswith(".vue"):
    src = "\n".join(re.findall(r"<script\b[^>]*>(.*?)</script>", src, re.S))
code = []  # the source with every string/comment body blanked out
lits = {}  # offset in `code` of a blanked string -> its text
i, n = 0, len(src)
while i < n:
    c = src[i]
    if src.startswith("//", i):
        j = src.find("\n", i)
        j = n if j < 0 else j
        code.append(" " * (j - i)); i = j
    elif src.startswith("/*", i):
        j = src.find("*/", i + 2)
        j = n if j < 0 else j + 2
        code.append(re.sub(r"[^\n]", " ", src[i:j])); i = j
    elif c in "'\"`":
        j = i + 1
        while j < n and src[j] != c and not (c != "`" and src[j] == "\n"):
            j += 2 if src[j] == "\\" else 1
        j = min(j + 1, n)
        lits[sum(map(len, code))] = src[i + 1:j - 1]
        code.append("'" + re.sub(r"[^\n]", " ", src[i + 1:j - 1]) + "'"); i = j
    else:
        code.append(c); i += 1
code = "".join(code)
pats = [
    r"(?m)^[ \t]*(?:import|export)\b[^;'`\"]*?\bfrom[ \t]*(?=')",
    r"(?m)^[ \t]*import[ \t]*(?=')",
    r"(?<![\w.$])import[ \t]*\([ \t]*(?=')",
]
for pat in pats:
    for m in re.finditer(pat, code):
        spec = lits.get(m.end(), "")
        if spec.startswith(("./", "../")):
            print(spec)
