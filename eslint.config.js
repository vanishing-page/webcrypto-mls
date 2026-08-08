import newneostandard from 'newneostandard'

export default [
    ...newneostandard({
        ts: true,
        ignores: [
            'lib.es5.d.ts',
            'dist/*',
            'public/*',
            'test/*.js',
            'example-realistic-demo/public/*',
            'example-realistic-demo/dist/*',
            'example-realistic-demo/worker-configuration.d.ts',
            // wrangler dev writes a bundled copy of the Worker here.
            // It is gitignored, but eslint does not read .gitignore, so
            // without this `npm run lint` fails with hundreds of errors
            // from generated code as soon as anyone runs the dev server.
            '**/.wrangler/**'
        ]
    }),
    {
        rules: {
            '@stylistic/operator-linebreak': 'off',
            '@stylistic/multiline-ternary': 'off',
            '@stylistic/no-multiple-empty-lines': [
                'error',
                {
                    max: 1,
                    maxEOF: 1
                }
            ],
            '@stylistic/indent': [
                'error',
                4,
                {
                    SwitchCase: 1,
                    ignoredNodes: ['TemplateLiteral *']
                }
            ],
            '@stylistic/comma-dangle': 'off',
            '@stylistic/no-multi-spaces': [
                'error',
                { ignoreEOLComments: true }
            ],
            '@stylistic/key-spacing': [
                'error',
                {
                    beforeColon: false,
                    afterColon: true,
                    ignoredNodes: ['TSInterfaceBody', 'TSTypeLiteral']
                }
            ]
        }
    },
    {
        files: ['**/*.ts', '**/*.tsx'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_'
                }
            ],
            '@typescript-eslint/consistent-type-imports': [
                'error',
                {
                    prefer: 'type-imports'
                }
            ],
            '@stylistic/type-annotation-spacing': [
                'error',
                {
                    before: false,
                    after: false,
                    overrides: {
                        arrow: 'ignore'
                    }
                }
            ],
            // Union and intersection types are written without spaces
            // around the operator, matching the tight colon style above.
            // Only the type operators are exempt -- spacing on every
            // other infix operator is still enforced.
            '@stylistic/space-infix-ops': [
                'error',
                { ignoreTypes: true }
            ]
        }
    }
]
