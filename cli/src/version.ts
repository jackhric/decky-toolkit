declare const CLI_VERSION: string | undefined;

export const VERSION: string = typeof CLI_VERSION === 'string' ? CLI_VERSION : '0.0.0-dev';
