/*
 * cpuid.exe — tiny optional helper for Capsule Fit on Windows.
 *
 * Windows has no /proc/cpuinfo or sysctl, so the app normally reports a
 * conservative "baseline" SIMD level. If you build this helper and drop the
 * .exe at runtime/platforms/win32-x64/cpuid.exe, hardware detection will
 * report the real SIMD capabilities instead.
 *
 * Output is three simple "key: value" lines:
 *   flags: sse4_2 avx fma avx2 avx512f ...
 *   cores: 8
 *   model: Intel(R) Core(TM) i7-XXXX CPU @ 3.40GHz
 *
 * Build (either one works):
 *   cl /O2 tools/cpuid.c /Fe:runtime\platforms\win32-x64\cpuid.exe
 *   gcc -O2 -o runtime/platforms/win32-x64/cpuid.exe tools/cpuid.c
 * Or run tools/build-cpuid.ps1 from a PowerShell that has a C compiler.
 */

#if defined(_MSC_VER)
  #include <intrin.h>
#else
  #include <cpuid.h>
#endif

#include <windows.h>
#include <stdio.h>
#include <string.h>

static void cpu_leaf(unsigned int leaf, unsigned int sub, unsigned int *a, unsigned int *b, unsigned int *c, unsigned int *d) {
#if defined(_MSC_VER)
  int info[4];
  __cpuidex(info, (int)leaf, (int)sub);
  *a = (unsigned int)info[0]; *b = (unsigned int)info[1]; *c = (unsigned int)info[2]; *d = (unsigned int)info[3];
#else
  __cpuid_count(leaf, sub, *a, *b, *c, *d);
#endif
}

static void emit_bit(const char *name, int on) {
  if (on) printf(" %s", name);
}

int main(void) {
  unsigned int a, b, c, d, max;
  char brand[256], clean[256];

  cpu_leaf(0, 0, &a, &b, &c, &d);
  max = a;

  cpu_leaf(1, 0, &a, &b, &c, &d);
  printf("flags:");
  emit_bit("sse4_2", (c >> 20) & 1);
  emit_bit("fma", (c >> 12) & 1);
  emit_bit("avx", (c >> 28) & 1);

  if (max >= 7) {
    cpu_leaf(7, 0, &a, &b, &c, &d);
    emit_bit("avx2", (b >> 5) & 1);
    emit_bit("avx512f", (b >> 16) & 1);
    emit_bit("avx512dq", (b >> 17) & 1);
    emit_bit("avx512cd", (b >> 28) & 1);
    emit_bit("avx512bw", (b >> 30) & 1);
    emit_bit("avx512vl", (b >> 31) & 1);
    emit_bit("gfni", (c >> 8) & 1);
    emit_bit("vaes", (c >> 9) & 1);
    emit_bit("amx_bf16", (b >> 22) & 1);
  }
  printf("\n");

  printf("cores: %lu\n", (unsigned long)GetActiveProcessorCount(ALL_PROCESSOR_GROUPS));

  memset(brand, 0, sizeof(brand));
  for (unsigned int leaf = 0x80000002; leaf <= 0x80000004; leaf++) {
    cpu_leaf(leaf, 0, &a, &b, &c, &d);
    memcpy(brand + 16 * (leaf - 0x80000002) + 0, &a, 4);
    memcpy(brand + 16 * (leaf - 0x80000002) + 4, &b, 4);
    memcpy(brand + 16 * (leaf - 0x80000002) + 8, &c, 4);
    memcpy(brand + 16 * (leaf - 0x80000002) + 12, &d, 4);
  }
  {
    const char *s = brand;
    size_t len = 0;
    while (*s == ' ') s++;
    while (s[len] && len < sizeof(clean) - 1) { clean[len] = s[len]; len++; }
    while (len > 0 && clean[len - 1] == ' ') len--;
    clean[len] = 0;
  }
  printf("model: %s\n", clean);
  return 0;
}