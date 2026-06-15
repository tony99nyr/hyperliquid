import { describe, it, expect } from 'vitest';
import {
  verifyPin,
  hashPin,
  verifyAdminSecret,
  getAdminSecret,
} from '@/lib/infrastructure/auth/auth';

describe('Authentication', () => {
  describe('verifyPin', () => {
    it('should return true for correct PIN', () => {
      const result = verifyPin('1234');
      expect(result).toBe(true);
    });

    it('should return false for incorrect PIN', () => {
      const result = verifyPin('0000');
      expect(result).toBe(false);
    });

    it('should return false for empty PIN', () => {
      const result = verifyPin('');
      expect(result).toBe(false);
    });
  });

  describe('hashPin', () => {
    it('should hash PIN consistently', () => {
      const hash1 = hashPin('1234');
      const hash2 = hashPin('1234');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 produces 64 hex chars
    });

    it('should produce different hashes for different PINs', () => {
      const hash1 = hashPin('1234');
      const hash2 = hashPin('5678');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyAdminSecret', () => {
    it('should return true for correct admin secret', () => {
      const result = verifyAdminSecret('test-admin-secret');
      expect(result).toBe(true);
    });

    it('should return false for incorrect admin secret', () => {
      const result = verifyAdminSecret('wrong-secret');
      expect(result).toBe(false);
    });

    it('should return false for empty secret', () => {
      const result = verifyAdminSecret('');
      expect(result).toBe(false);
    });
  });

  describe('getAdminSecret', () => {
    it('should return admin secret from environment', () => {
      const secret = getAdminSecret();
      expect(secret).toBe('test-admin-secret');
    });

    it('should throw error if ADMIN_SECRET not set', () => {
      const originalSecret = process.env.ADMIN_SECRET;
      delete process.env.ADMIN_SECRET;

      expect(() => getAdminSecret()).toThrow('ADMIN_SECRET environment variable not configured');

      process.env.ADMIN_SECRET = originalSecret;
    });
  });
});
