import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';

export class EmailUnsubscribeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Read config from SSM Parameter Store (set these before deploying — see README)
    // All stored as String type; Lambda environment variables are encrypted at rest by AWS KMS
    const googleClientId = ssm.StringParameter.valueForStringParameter(
      this, '/email-unsubscribe/google-client-id'
    );
    const googleClientSecret = ssm.StringParameter.valueForStringParameter(
      this, '/email-unsubscribe/google-client-secret'
    );
    const sessionSecret = ssm.StringParameter.valueForStringParameter(
      this, '/email-unsubscribe/session-secret'
    );
    const redirectUri = ssm.StringParameter.valueForStringParameter(
      this, '/email-unsubscribe/redirect-uri'
    );

    // Bundle app code: copies source files and runs npm ci --only=production inside Docker
    const appCode = lambda.Code.fromAsset(path.join(__dirname, '../..'), {
      bundling: {
        image: cdk.DockerImage.fromRegistry('node:20-alpine'),
        command: [
          'sh', '-c',
          [
            'cp -r /asset-input/server.js /asset-input/public /asset-input/package*.json /asset-output/',
            'cd /asset-output',
            'npm ci --only=production --silent',
          ].join(' && '),
        ],
        user: 'root',
      },
    });

    const fn = new lambda.Function(this, 'AppFunction', {
      functionName: 'email-unsubscribe',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'server.handler',
      code: appCode,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        NODE_ENV: 'production',
        GOOGLE_CLIENT_ID: googleClientId,
        GOOGLE_CLIENT_SECRET: googleClientSecret,
        SESSION_SECRET: sessionSecret,
        REDIRECT_URI: redirectUri,
      },
    });

    // Lambda Function URL — provides HTTPS endpoint with no API Gateway cost
    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.ALL],
        allowedHeaders: ['*'],
      },
    });

    new cdk.CfnOutput(this, 'FunctionUrl', {
      value: fnUrl.url,
      description: 'Lambda Function URL — add <this>/auth/callback to Google Cloud Console',
    });
  }
}
