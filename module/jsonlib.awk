# Shared helper for the JSON emitter. Kept in a separate file so the scanning
# logic stays readable, and loaded with `awk -f jsonlib.awk -f ...`.
#
# Escaping is done byte by byte rather than with gsub because gsub's handling of
# backslashes in the replacement differs between gawk and busybox awk: with
# gsub(/"/, "\\\"") gawk emits \" while busybox emits a bare ". A manual loop
# behaves identically on both, which is what matters - the device runs busybox
# awk, CI and the desktop run gawk.

function esc(s,   out, i, n, c) {
  out = ""; n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if      (c == "\"") out = out "\\\""
    else if (c == "\\") out = out "\\\\"
    else if (c == "\t") out = out "\\t"
    else if (c == "\r") out = out "\\r"
    else if (c == "\n") out = out "\\n"
    else                out = out c
  }
  return out
}

# Build "key":"value" with correct escaping.
function pair(k, v) { return "\"" k "\":\"" esc(v) "\"" }

# Build "key":number, or "key":null when the value is not a clean number.
# JSON has no NaN/Infinity, so a bad parse must not leak into the document.
function num(k, v) {
  if (v == "" || v ~ /^-?[0-9]+$/ || v ~ /^-?[0-9]+\.[0-9]+$/) {
    if (v == "") return "\"" k "\":0"
    return "\"" k "\":" v
  }
  return "\"" k "\":null"
}