/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'server',
  testMatch: ['**/__tests__/**/*.test.ts'],
  clearMocks: true,
};
