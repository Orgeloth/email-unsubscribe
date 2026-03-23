import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';

export class EmailUnsubscribeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------------
    // DynamoDB tables
    // ---------------------------------------------------------------------------
    const sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: 'email-unsubscribe-sessions',
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const allowlistTable = new dynamodb.Table(this, 'AllowlistTable', {
      tableName: 'email-unsubscribe-allowlist',
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---------------------------------------------------------------------------
    // Secrets from SSM Parameter Store
    // ---------------------------------------------------------------------------
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

    // ---------------------------------------------------------------------------
    // Lambda function
    // ---------------------------------------------------------------------------
    const appCode = lambda.Code.fromAsset(path.join(__dirname, '../..'), {
      bundling: {
        image: cdk.DockerImage.fromRegistry('node:20-alpine'),
        command: [
          'sh', '-c',
          [
            'cp -r /asset-input/server.js /asset-input/public /asset-input/views /asset-input/package*.json /asset-output/',
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
        PORT: '3000',
        SESSIONS_TABLE: sessionsTable.tableName,
        ALLOWLIST_TABLE: allowlistTable.tableName,
        GOOGLE_CLIENT_ID: googleClientId,
        GOOGLE_CLIENT_SECRET: googleClientSecret,
        SESSION_SECRET: sessionSecret,
        REDIRECT_URI: redirectUri,
      },
    });

    // Grant Lambda read/write access to both tables
    sessionsTable.grantReadWriteData(fn);
    allowlistTable.grantReadWriteData(fn);

    // ---------------------------------------------------------------------------
    // Lambda Function URL (HTTPS endpoint, no API Gateway cost)
    // ---------------------------------------------------------------------------
    // No CORS config — the frontend is served by the same Lambda (same-origin),
    // so cross-origin access is intentionally blocked at the infrastructure level.
    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // ---------------------------------------------------------------------------
    // Seed first admin user (runs once on first deploy if adminEmail context set)
    // Usage: npx cdk deploy --context adminEmail=you@gmail.com
    // ---------------------------------------------------------------------------
    const adminEmail = this.node.tryGetContext('adminEmail');
    if (adminEmail) {
      new cr.AwsCustomResource(this, 'SeedAdminUser', {
        onCreate: {
          service: 'DynamoDB',
          action: 'putItem',
          parameters: {
            TableName: allowlistTable.tableName,
            Item: {
              email:     { S: adminEmail },
              firstName: { S: '' },
              lastName:  { S: '' },
              picture:   { S: '' },
              status:    { S: 'active' },
              isAdmin:   { BOOL: true },
              addedAt:   { S: new Date().toISOString() },
              lastLoginAt: { NULL: true },
            },
            ConditionExpression: 'attribute_not_exists(email)',
          },
          physicalResourceId: cr.PhysicalResourceId.of(`seed-admin-${adminEmail}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: [allowlistTable.tableArn],
        }),
      });
    }

    // ---------------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'FunctionUrl', {
      value: fnUrl.url,
      description: 'App URL — use <this>/auth/callback as the OAuth redirect URI',
    });

    new cdk.CfnOutput(this, 'SessionsTableName', {
      value: sessionsTable.tableName,
    });

    new cdk.CfnOutput(this, 'AllowlistTableName', {
      value: allowlistTable.tableName,
    });
  }
}
