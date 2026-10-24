#!/usr/bin/env python3
"""Check that a native library implements every JNI method of the official Java jar.

usage: check_jni.py --javap <javap> --official <jar> --ours <classes dir> --lib <dylib>
                    --include <regex> [--exclude <regex>]

For every `native` method declared by classes of the official jar (the one Minecraft puts on
the classpath) whose class name matches --include and not --exclude:

  1. our compiled classes (built from the same upstream commit as the library) must declare the
     same method with the same descriptor. JNI symbol names do not encode the signature of
     non-overloaded methods, so a symbol match alone could hide an argument mismatch;
  2. the library must export the JNI symbol (short or long form).

Exits non-zero, listing every problem, if any check fails.
"""
import argparse
import os
import re
import subprocess
import sys
import zipfile


def list_classes(src):
    if os.path.isdir(src):
        out = []
        for root, _, files in os.walk(src):
            for f in files:
                if f.endswith('.class'):
                    out.append(os.path.relpath(os.path.join(root, f), src))
    else:
        out = zipfile.ZipFile(src).namelist()
    return sorted(n[:-6].replace('/', '.') for n in out if n.endswith('.class'))


def native_methods(javap, src, include, exclude):
    classes = [c for c in list_classes(src) if include.search(c) and not (exclude and exclude.search(c))]
    res = set()
    for i in range(0, len(classes), 150):
        batch = classes[i:i + 150]
        p = subprocess.run([javap, '-p', '-s', '-cp', src] + batch, capture_output=True, text=True)
        if p.returncode != 0:
            sys.exit('javap failed on %s:\n%s' % (src, p.stderr))
        cur = None
        pending = None
        for line in p.stdout.splitlines():
            s = line.strip()
            if not line.startswith(' ') and s.endswith('{'):
                toks = s[:-1].replace(',', ' ').split()
                for kw in ('class', 'interface', 'enum'):
                    if kw in toks:
                        cur = toks[toks.index(kw) + 1].split('<')[0]
                        break
                continue
            if re.search(r'(^|\s)native\s', s):
                pending = s.split('(')[0].split()[-1]
                continue
            if pending and s.startswith('descriptor:'):
                res.add((cur, pending, s.split(':', 1)[1].strip()))
                pending = None
    return res


def mangle(s):
    out = []
    for ch in s:
        if ch == '/' or ch == '.':
            out.append('_')
        elif ch == '_':
            out.append('_1')
        elif ch == ';':
            out.append('_2')
        elif ch == '[':
            out.append('_3')
        elif ch.isascii() and ch.isalnum():
            out.append(ch)
        else:
            out.append('_0%04x' % ord(ch))
    return ''.join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--javap', required=True)
    ap.add_argument('--official', required=True)
    ap.add_argument('--ours', required=True)
    ap.add_argument('--lib', required=True)
    ap.add_argument('--include', required=True)
    ap.add_argument('--exclude')
    a = ap.parse_args()
    inc = re.compile(a.include)
    exc = re.compile(a.exclude) if a.exclude else None

    official = native_methods(a.javap, a.official, inc, exc)
    ours = native_methods(a.javap, a.ours, inc, exc)
    nm = subprocess.run(['nm', '-g', '-j', '-U', a.lib], capture_output=True, text=True, check=True)
    exported = {s[1:] if s.startswith('_') else s for s in nm.stdout.split()}

    # Some classes (OpenAL, OpenCL, parts of GL) bind their natives at run time with
    # RegisterNatives from an exported `initNativeStubs`; their tables hold the method name and
    # descriptor as C strings.
    with open(a.lib, 'rb') as fh:
        strings = set(re.findall(rb'[\x20-\x7e]{2,}', fh.read()))

    problems = []
    registered = 0
    for cls, name, desc in sorted(official):
        if (cls, name, desc) not in ours:
            problems.append('signature mismatch: %s.%s%s is not declared by the upstream source' % (cls, name, desc))
        short = 'Java_%s_%s' % (mangle(cls), mangle(name))
        long_ = '%s__%s' % (short, mangle(desc[1:desc.index(')')]))
        if short in exported or long_ in exported:
            continue
        if ('Java_%s_initNativeStubs' % mangle(cls)) in exported \
                and name.encode() in strings and desc.encode() in strings:
            registered += 1
            continue
        problems.append('missing symbol: %s (%s.%s%s)' % (short, cls, name, desc))
    print('check_jni: %s vs %s: %d native methods checked (%d bound by RegisterNatives), %d problems'
          % (os.path.basename(a.official), os.path.basename(a.lib), len(official), registered, len(problems)))
    for p in problems:
        print('  ' + p)
    if not official:
        sys.exit('check_jni: no native methods found; wrong --include?')
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
