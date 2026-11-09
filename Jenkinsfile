pipeline {
    agent {
        label 'aws-small'
    }

    tools {
        nodejs 'nodejs-22'
    }

    options {
        // A new push to the same branch or PR supersedes the running build, so abort it instead of queueing.
        disableConcurrentBuilds(abortPrevious: true)
    }

    environment {
        // Must match the `playwright` version in `package-lock.json`.
        PLAYWRIGHT_IMAGE = 'mcr.microsoft.com/playwright:v1.61.0-noble'
    }

    stages {
        stage('Install') {
            steps {
                sh 'npm ci'
            }
        }

        stage('Lint') {
            steps {
                sh 'npm run lint'
            }
        }

        stage('Validate Translations') {
            steps {
                sh 'npm run validate-translations'
            }
        }

        stage('Build') {
            steps {
                sh 'npm run test-build'
            }
        }

        stage('Test') {
            steps {
                // Vitest runs in browser mode, so run it in the Playwright image, which has Chromium and its system libraries.
                sh '''
                    docker run --rm \
                        --user "$(id -u):$(id -g)" \
                        --ipc=host \
                        -e HOME=/tmp \
                        -v "$WORKSPACE:/app" \
                        -w /app \
                        "$PLAYWRIGHT_IMAGE" \
                        npx vitest run --browser.headless
                '''
            }
        }
    }

    post {
        always {
            cleanWs()
        }
    }
}
