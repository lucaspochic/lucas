import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, totp, verifyTotp } from "@/server/security/totp";
import { decryptSecret, encryptSecret } from "@/server/security/encryption";

// RFC 6238, annexe B : secret ASCII « 12345678901234567890 », SHA-1 (8 chiffres ; on garde les 6 derniers).
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const at = (seconds: number) => new Date(seconds * 1000);

describe("TOTP (RFC 6238)", () => {
  it("base32 aller-retour et vecteur de référence", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq").toString()).toBe("12345678901234567890");
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(s))).toBe(s);
  });

  it("codes des vecteurs de test officiels", () => {
    expect(totp(RFC_SECRET, at(59))).toBe("287082");
    expect(totp(RFC_SECRET, at(1111111109))).toBe("081804");
    expect(totp(RFC_SECRET, at(1111111111))).toBe("050471");
    expect(totp(RFC_SECRET, at(1234567890))).toBe("005924");
    expect(totp(RFC_SECRET, at(2000000000))).toBe("279037");
  });

  it("tolérance d'un pas, refus au-delà, anti-rejeu, format", () => {
    const now = at(1234567890);
    const step = Math.floor(1234567890 / 30);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, at(1234567890 - 30)), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, at(1234567890 + 30)), now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, at(1234567890 - 90)), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "005 924", now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, "005924", now, step)).toBeNull(); // déjà utilisé
    expect(verifyTotp(RFC_SECRET, "12345", now)).toBeNull();
    expect(otpauthUri("Gestion", "a@b.fr", RFC_SECRET)).toBe(
      "otpauth://totp/Gestion%3Aa%40b.fr?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Gestion&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("chiffrement des secrets", () => {
  it("AES-256-GCM : aller-retour, IV aléatoire, altération détectée", () => {
    const a = encryptSecret("SECRET");
    const b = encryptSecret("SECRET");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("SECRET");
    const parts = a.split(":");
    const tampered = [parts[0], parts[1], parts[2], Buffer.from("autre").toString("base64url")].join(":");
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
