import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apprunner from 'aws-cdk-lib/aws-apprunner';
import * as assets from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';
import * as path from 'path';

export class EmailUnsubscribeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Build Docker image and push to ECR automatically during cdk deploy
    const imageAsset = new assets.DockerImageAsset(this, 'AppImage', {
      directory: path.join(__dirname, '../..'),
    });

    // Role that allows App Runner to pull the image from ECR
    const accessRole = new iam.Role(this, 'AppRunnerAccessRole', {
      assumedBy: new iam.ServicePrincipal('build.apprunner.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSAppRunnerServicePolicyForECRAccess'
        ),
      ],
    });

    // Role for the running container — grants access to SSM Parameter Store
    const instanceRole = new iam.Role(this, 'AppRunnerInstanceRole', {
      assumedBy: new iam.ServicePrincipal('tasks.apprunner.amazonaws.com'),
    });

    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/email-unsubscribe/*`,
        ],
      })
    );

    // Allow decryption of SecureString parameters
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` },
        },
      })
    );

    // SSM parameter ARNs — you create these once before deploying (see README)
    const ssmBase = `arn:aws:ssm:${this.region}:${this.account}:parameter/email-unsubscribe`;

    const service = new apprunner.CfnService(this, 'AppRunnerService', {
      serviceName: 'email-unsubscribe',
      sourceConfiguration: {
        authenticationConfiguration: {
          accessRoleArn: accessRole.roleArn,
        },
        autoDeploymentsEnabled: false,
        imageRepository: {
          imageRepositoryType: 'ECR',
          imageIdentifier: imageAsset.imageUri,
          imageConfiguration: {
            port: '3000',
            runtimeEnvironmentVariables: [
              { name: 'NODE_ENV', value: 'production' },
              { name: 'PORT', value: '3000' },
            ],
            // Secrets are injected from SSM Parameter Store at runtime
            runtimeEnvironmentSecrets: [
              { name: 'GOOGLE_CLIENT_ID', value: `${ssmBase}/google-client-id` },
              { name: 'GOOGLE_CLIENT_SECRET', value: `${ssmBase}/google-client-secret` },
              { name: 'SESSION_SECRET', value: `${ssmBase}/session-secret` },
              { name: 'REDIRECT_URI', value: `${ssmBase}/redirect-uri` },
            ],
          },
        },
      },
      instanceConfiguration: {
        cpu: '0.25 vCPU',
        memory: '0.5 GB',
        instanceRoleArn: instanceRole.roleArn,
      },
      healthCheckConfiguration: {
        protocol: 'HTTP',
        path: '/health',
        interval: 10,
        timeout: 5,
        healthyThreshold: 1,
        unhealthyThreshold: 5,
      },
      // Keep 1 instance provisioned (minimum for App Runner)
      autoScalingConfigurationArn: undefined,
    });

    new cdk.CfnOutput(this, 'ServiceUrl', {
      value: `https://${service.attrServiceUrl}`,
      description: 'App Runner URL — add this to Google Cloud Console redirect URIs',
    });
  }
}
