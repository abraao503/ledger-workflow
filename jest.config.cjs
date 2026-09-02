/** @type {import('jest').Config} */
module.exports = {
  roots: ['<rootDir>/src'],
  testEnvironment: 'node',
  testRegex: '.*\\.(spec|test)\\.ts$',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
        useESM: true,
      },
    ],
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  clearMocks: true,
};
