pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        timestamps()
        timeout(time: 20, unit: 'MINUTES')
        skipDefaultCheckout(true)
    }

    triggers {
        // Poll the configured main-branch SCM once per minute. Jenkins only
        // starts a build when the repository revision has changed.
        pollSCM('* * * * *')
    }

    environment {
        COMPOSE_PROJECT_NAME = 'seed-eco-analyser'
        DOCKER_BUILDKIT = '1'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Build and test') {
            steps {
                sh 'docker compose build --pull'
            }
        }

        stage('Deploy') {
            steps {
                sh 'docker compose up -d --no-build --remove-orphans'
            }
        }

        stage('Health check') {
            steps {
                sh '''
                    container_id="$(docker compose ps -q line-value)"
                    if [ -z "$container_id" ]; then
                        echo "The line-value container was not created."
                        exit 1
                    fi

                    attempt=1
                    while [ "$attempt" -le 45 ]; do
                        status="$(docker inspect --format='{{.State.Health.Status}}' "$container_id")"
                        if [ "$status" = "healthy" ]; then
                            echo "SeedEcoAnalyser is healthy."
                            exit 0
                        fi
                        if [ "$status" = "unhealthy" ]; then
                            echo "SeedEcoAnalyser reported an unhealthy state."
                            exit 1
                        fi
                        sleep 2
                        attempt=$((attempt + 1))
                    done

                    echo "Timed out while waiting for SeedEcoAnalyser to become healthy."
                    exit 1
                '''
            }
        }
    }

    post {
        failure {
            sh 'docker compose ps || true'
            sh 'docker compose logs --no-color --tail=150 line-value || true'
        }
    }
}
